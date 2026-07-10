'use strict';

/**
 * Hierarchy stub router — handles /api/v1/organizations, hierarchies, networks.
 * In-memory persistence; resets on gateway restart.
 * Mounted at /api/v1/organizations in app.js.
 */
const express = require('express');
const router  = express.Router();

let orgs = [
  { id: 'org-1', name: 'Airtel UBR — North', description: 'Northern circle operations', createdAt: new Date().toISOString() },
  { id: 'org-2', name: 'Airtel UBR — South', description: 'Southern circle operations', createdAt: new Date().toISOString() },
];

let hierarchies = {
  'org-1': [
    { id: 'hv-1', name: 'Haryana Network',   organizationId: 'org-1', description: 'Haryana state', createdAt: new Date().toISOString() },
    { id: 'hv-2', name: 'Punjab Network',    organizationId: 'org-1', description: 'Punjab state',   createdAt: new Date().toISOString() },
  ],
  'org-2': [
    { id: 'hv-3', name: 'Karnataka Network', organizationId: 'org-2', description: 'Karnataka state', createdAt: new Date().toISOString() },
  ],
};

let networks = {
  'hv-1': [
    { id: 'net-1', name: 'Gurgaon Cluster',   hierarchyViewId: 'hv-1', organizationId: 'org-1', createdAt: new Date().toISOString() },
    { id: 'net-2', name: 'Faridabad Cluster',  hierarchyViewId: 'hv-1', organizationId: 'org-1', createdAt: new Date().toISOString() },
  ],
  'hv-2': [
    { id: 'net-3', name: 'Chandigarh Cluster', hierarchyViewId: 'hv-2', organizationId: 'org-1', createdAt: new Date().toISOString() },
  ],
  'hv-3': [
    { id: 'net-4', name: 'Bangalore Cluster',  hierarchyViewId: 'hv-3', organizationId: 'org-2', createdAt: new Date().toISOString() },
  ],
};

let nextId = 100;
const uid = () => `id-${++nextId}`;

// ── Organizations ─────────────────────────────────────────────────────────────
router.get('/', (_req, res) => res.json(orgs));

router.post('/', (req, res) => {
  const org = { id: uid(), ...req.body, createdAt: new Date().toISOString() };
  orgs.push(org);
  res.status(201).json(org);
});

router.put('/:id', (req, res) => {
  const idx = orgs.findIndex((o) => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Organization not found' });
  orgs[idx] = { ...orgs[idx], ...req.body };
  res.json(orgs[idx]);
});

router.delete('/:id', (req, res) => {
  const before = orgs.length;
  orgs = orgs.filter((o) => o.id !== req.params.id);
  if (orgs.length === before) return res.status(404).json({ error: 'Organization not found' });
  res.status(204).end();
});

// ── Hierarchies under org ─────────────────────────────────────────────────────
router.get('/:orgId/hierarchies', (req, res) => {
  res.json(hierarchies[req.params.orgId] || []);
});

router.post('/:orgId/hierarchies', (req, res) => {
  const hv = { id: uid(), organizationId: req.params.orgId, ...req.body, createdAt: new Date().toISOString() };
  if (!hierarchies[req.params.orgId]) hierarchies[req.params.orgId] = [];
  hierarchies[req.params.orgId].push(hv);
  res.status(201).json(hv);
});

router.delete('/:orgId/hierarchies/:hvId', (req, res) => {
  const list = hierarchies[req.params.orgId] || [];
  const before = list.length;
  hierarchies[req.params.orgId] = list.filter((h) => h.id !== req.params.hvId);
  if (hierarchies[req.params.orgId].length === before) return res.status(404).json({ error: 'Hierarchy not found' });
  res.status(204).end();
});

// ── Networks under hierarchy ──────────────────────────────────────────────────
router.get('/:orgId/hierarchies/:hvId/networks', (req, res) => {
  res.json(networks[req.params.hvId] || []);
});

router.post('/:orgId/hierarchies/:hvId/networks', (req, res) => {
  const net = { id: uid(), hierarchyViewId: req.params.hvId, organizationId: req.params.orgId, ...req.body, createdAt: new Date().toISOString() };
  if (!networks[req.params.hvId]) networks[req.params.hvId] = [];
  networks[req.params.hvId].push(net);
  res.status(201).json(net);
});

router.delete('/:orgId/hierarchies/:hvId/networks/:netId', (req, res) => {
  const list = networks[req.params.hvId] || [];
  const before = list.length;
  networks[req.params.hvId] = list.filter((n) => n.id !== req.params.netId);
  if (networks[req.params.hvId].length === before) return res.status(404).json({ error: 'Network not found' });
  res.status(204).end();
});

module.exports = router;
