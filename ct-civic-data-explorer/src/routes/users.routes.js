import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../lib/http-error.js';
import { emailSchema, idParams } from '../lib/schemas.js';
import { requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as users from '../repositories/users.js';
import { recordAudit } from '../services/audit.js';
import * as auth from '../services/auth.service.js';
import { presentUser } from '../services/presenters.js';

const ROLES = ['admin', 'staff'];

const inviteSchema = z.object({
  email: emailSchema,
  firstName: z.string().trim().min(1, 'First name is required').max(100),
  lastName: z.string().trim().min(1, 'Last name is required').max(100),
  role: z.enum(ROLES, 'Choose a role'),
});

const updateSchema = z
  .object({ role: z.enum(ROLES).optional(), isActive: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.isActive !== undefined, 'Nothing to update');

export const usersRouter = Router();
usersRouter.use(requireRole('admin'));

usersRouter.get('/', async (_req, res) => {
  res.json((await users.list()).map(presentUser));
});

usersRouter.post('/', validate(inviteSchema), async (req, res) => {
  const { user, link } = await auth.inviteUser(req.valid.body);
  await recordAudit(req, 'user.invited', { target: userTarget(user), details: { role: user.role } });
  res.status(201).json({ user: presentUser(user), link });
});

usersRouter.patch('/:id', validate(idParams, 'params'), validate(updateSchema), async (req, res) => {
  const { id } = req.valid.params;
  const { role, isActive } = req.valid.body;
  if (id === req.user.id && (isActive === false || (role && role !== 'admin'))) {
    throw new HttpError(400, 'You cannot remove your own admin access');
  }
  const before = await users.findById(id);
  if (!before) throw new HttpError(404, 'User not found');
  const user = await users.update(id, { role, isActive });
  if (isActive === false) await users.deleteSessions(id);
  if (role !== undefined && role !== before.role) {
    await recordAudit(req, 'user.role_changed', { target: userTarget(user), details: { from: before.role, to: role } });
  }
  if (isActive !== undefined && isActive !== before.is_active) {
    await recordAudit(req, isActive ? 'user.reactivated' : 'user.deactivated', { target: userTarget(user) });
  }
  res.json(presentUser(user));
});

usersRouter.post('/:id/password-link', validate(idParams, 'params'), async (req, res) => {
  const { user, link } = await auth.createPasswordLink(req.valid.params.id);
  await recordAudit(req, 'user.password_link_issued', { target: userTarget(user) });
  res.json({ user: presentUser(user), link });
});

function userTarget(user) {
  return { type: 'user', id: user.id, label: user.email };
}
