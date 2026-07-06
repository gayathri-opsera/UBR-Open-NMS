'use strict';

const { mountHealthChecks } = require('../src/health');

function makeApp() {
  const routes = {};
  const app = {
    get: (path, handler) => { routes[path] = handler; },
    routes,
  };
  return app;
}

describe('mountHealthChecks', () => {
  it('mounts /healthz returning {status: ok}', async () => {
    const app = makeApp();
    mountHealthChecks(app);
    const res = { json: jest.fn() };
    app.routes['/healthz']({}, res);
    expect(res.json).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('/readyz returns ready when no check fn provided', async () => {
    const app = makeApp();
    mountHealthChecks(app);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await app.routes['/readyz']({}, res);
    expect(res.json).toHaveBeenCalledWith({ status: 'ready' });
  });

  it('/readyz returns 503 when readiness check fails', async () => {
    const app = makeApp();
    mountHealthChecks(app, async () => ({ ready: false, reason: 'DB down' }));
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await app.routes['/readyz']({}, res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ status: 'not_ready', reason: 'DB down' });
  });

  it('/readyz returns 503 when readiness check throws', async () => {
    const app = makeApp();
    mountHealthChecks(app, async () => { throw new Error('crash'); });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await app.routes['/readyz']({}, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
