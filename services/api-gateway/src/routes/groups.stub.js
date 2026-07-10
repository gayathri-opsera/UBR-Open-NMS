'use strict';

/**
 * Groups stub — CRUD for device groups.
 * Mounted at /api/v1/groups. No dedicated microservice yet.
 */
const express = require('express');
const router  = express.Router();

let groups = [
  {
    id: 'grp-1', name: 'North BTS Cluster', description: 'All BTS devices in northern region',
    deviceIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 'grp-2', name: 'CPE — Gurugram', description: 'CPE devices in Gurugram circle',
    deviceIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 'grp-3', name: 'Production Fleet', description: 'All production-tagged devices',
    deviceIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
];
let nextId = 4;

// GET /api/v1/groups
router.get('/', (_req, res) => res.json(groups));

// GET /api/v1/groups/summary
router.get('/summary', (_req, res) => {
  res.json(groups.map((g) => ({
    id:          g.id,
    name:        g.name,
    description: g.description,
    deviceCount: g.deviceIds.length,
    updatedAt:   g.updatedAt,
  })));
});

// GET /api/v1/groups/:id
router.get('/:id', (req, res) => {
  const g = groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  res.json(g);
});

// POST /api/v1/groups
router.post('/', (req, res) => {
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
  const now = new Date().toISOString();
  const g = { id: `grp-${nextId++}`, name, description: description || '', deviceIds: [], createdAt: now, updatedAt: now };
  groups.push(g);
  res.status(201).json(g);
});

// PUT /api/v1/groups/:id
router.put('/:id', (req, res) => {
  const idx = groups.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  groups[idx] = { ...groups[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  res.json(groups[idx]);
});

// DELETE /api/v1/groups/:id
router.delete('/:id', (req, res) => {
  const idx = groups.findIndex((x) => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  groups.splice(idx, 1);
  res.status(204).end();
});

// POST /api/v1/groups/:id/devices  { deviceIds: [] }
router.post('/:id/devices', (req, res) => {
  const g = groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  const toAdd = req.body?.deviceIds || [];
  g.deviceIds = [...new Set([...g.deviceIds, ...toAdd])];
  g.updatedAt  = new Date().toISOString();
  res.json(g);
});

// DELETE /api/v1/groups/:id/devices/:deviceId
router.delete('/:id/devices/:deviceId', (req, res) => {
  const g = groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ code: 'NOT_FOUND', message: 'Group not found' });
  g.deviceIds = g.deviceIds.filter((d) => d !== req.params.deviceId);
  g.updatedAt  = new Date().toISOString();
  res.json(g);
});

module.exports = router;
