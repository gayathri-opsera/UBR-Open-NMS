'use strict';

const ldap = require('ldapjs');
const CircuitBreaker = require('opossum');
const config = require('../config');
const logger = require('../utils/logger');

let client = null;

function createClient() {
  return ldap.createClient({
    url: config.ldap.url,
    tlsOptions: config.ldap.tlsOptions,
    timeout: 5000,
    connectTimeout: 5000,
    reconnect: false,
  });
}

/**
 * Bind the service account to LDAP, then search for the given username.
 * Returns the user entry on success, throws on failure or not-found.
 */
async function ldapAuthenticate(username, password) {
  return new Promise((resolve, reject) => {
    const c = createClient();

    c.on('error', (err) => {
      reject(err);
    });

    c.bind(config.ldap.bindDn, config.ldap.bindPassword, (bindErr) => {
      if (bindErr) {
        c.destroy();
        return reject(new Error(`LDAP service bind failed: ${bindErr.message}`));
      }

      const filter = config.ldap.searchFilter.replace('{{username}}', ldap.escape(username));
      const opts = { filter, scope: 'sub', attributes: ['uid', 'mail', 'cn', 'memberOf'] };

      c.search(config.ldap.baseDn, opts, (searchErr, res) => {
        if (searchErr) {
          c.destroy();
          return reject(searchErr);
        }

        const entries = [];

        res.on('searchEntry', (entry) => {
          entries.push(entry.object);
        });

        res.on('error', (err) => {
          c.destroy();
          reject(err);
        });

        res.on('end', () => {
          if (entries.length === 0) {
            c.destroy();
            return reject(Object.assign(new Error('User not found in directory'), { code: 'USER_NOT_FOUND' }));
          }

          const userDn = entries[0].dn;

          // Verify the user's own credentials by binding as that user.
          c.bind(userDn, password, (userBindErr) => {
            c.destroy();
            if (userBindErr) {
              return reject(Object.assign(new Error('Invalid credentials'), { code: 'INVALID_CREDENTIALS' }));
            }
            resolve(entries[0]);
          });
        });
      });
    });
  });
}

const breaker = new CircuitBreaker(ldapAuthenticate, {
  timeout: config.ldap.circuitBreaker.timeout,
  errorThresholdPercentage: config.ldap.circuitBreaker.errorThresholdPercentage,
  resetTimeout: config.ldap.circuitBreaker.resetTimeout,
  name: 'ldap-auth',
});

breaker.on('open', () => logger.warn('LDAP circuit breaker OPEN — falling back to local DB'));
breaker.on('halfOpen', () => logger.info('LDAP circuit breaker HALF-OPEN — testing connection'));
breaker.on('close', () => logger.info('LDAP circuit breaker CLOSED — LDAP available'));
breaker.on('fallback', () => logger.warn('LDAP circuit breaker fallback triggered'));

/**
 * Exported function: attempt LDAP auth. Returns the LDAP entry or throws.
 * Callers must handle CircuitBreaker open state (Opossum throws OpenCircuitError).
 */
async function authenticate(username, password) {
  return breaker.fire(username, password);
}

function isOpen() {
  return breaker.opened;
}

module.exports = { authenticate, isOpen };
