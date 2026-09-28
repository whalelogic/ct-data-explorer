import { Router } from 'express';
import { idParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { presentPlace } from '../services/presenters.js';
import { getTownProfile, listTowns } from '../services/towns.service.js';

export const townsRouter = Router();

townsRouter.get('/', async (_req, res) => {
  res.json((await listTowns()).map(presentPlace));
});

townsRouter.get('/:id', validate(idParams, 'params'), async (req, res) => {
  res.json(await getTownProfile(req.valid.params.id));
});
