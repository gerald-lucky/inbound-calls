'use strict';

const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// GET /api/tenants
router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .order('lot_number', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/tenants/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tenants')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Tenant not found' });
  res.json(data);
});

// POST /api/tenants
router.post('/', async (req, res) => {
  const {
    first_name, last_name, phone_number, email,
    lot_number, lot_rent_amount, move_in_date, balance_due,
  } = req.body;

  if (!first_name || !last_name || !phone_number || !lot_number || !lot_rent_amount || !move_in_date) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data, error } = await supabase
    .from('tenants')
    .insert({
      first_name,
      last_name,
      phone_number,
      email: email || null,
      lot_number,
      lot_rent_amount: Number(lot_rent_amount),
      move_in_date,
      balance_due: balance_due != null ? Number(balance_due) : 0,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/tenants/:id
router.patch('/:id', async (req, res) => {
  const allowed = [
    'first_name', 'last_name', 'phone_number', 'email',
    'lot_number', 'lot_rent_amount', 'move_in_date', 'balance_due',
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('tenants')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/tenants/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('tenants')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
