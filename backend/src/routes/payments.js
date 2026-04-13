'use strict';

const { Router } = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// GET /api/payments?tenant_id=&limit=
router.get('/', async (req, res) => {
  let query = supabase
    .from('payments_with_tenant')
    .select('*')
    .order('payment_date', { ascending: false });

  if (req.query.tenant_id) {
    query = query.eq('tenant_id', req.query.tenant_id);
  }

  const limit = parseInt(req.query.limit, 10);
  if (!isNaN(limit) && limit > 0) query = query.limit(limit);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/payments/:id
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('payments')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Payment not found' });
  res.json(data);
});

// POST /api/payments
router.post('/', async (req, res) => {
  const { tenant_id, amount, payment_date, month_year, status, notes } = req.body;

  if (!tenant_id || amount == null || !payment_date || !month_year) {
    return res.status(400).json({ error: 'Missing required fields: tenant_id, amount, payment_date, month_year' });
  }

  // Validate month_year format
  if (!/^\d{4}-\d{2}$/.test(month_year)) {
    return res.status(400).json({ error: 'month_year must be YYYY-MM format' });
  }

  const validStatuses = ['paid', 'partial', 'waived'];
  const resolvedStatus = validStatuses.includes(status) ? status : 'paid';

  const { data, error } = await supabase
    .from('payments')
    .insert({
      tenant_id,
      amount: Number(amount),
      payment_date,
      month_year,
      status: resolvedStatus,
      notes: notes || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/payments/:id
router.patch('/:id', async (req, res) => {
  const allowed = ['amount', 'payment_date', 'month_year', 'status', 'notes'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('payments')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/payments/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase
    .from('payments')
    .delete()
    .eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;
