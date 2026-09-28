import { Router } from 'express';
import { z } from 'zod';
import { idParams } from '../lib/schemas.js';
import { validate } from '../middleware/validate.js';
import { draftSummary } from '../services/ai/index.js';
import {
  buildCard,
  createCard,
  deleteCard,
  duplicateCard,
  getCard,
  listCards,
  parseStoredSelection,
  updateCard,
} from '../services/cards.service.js';
import { cardFilename, renderCardPdf } from '../services/pdf/index.js';
import { presentCard } from '../services/presenters.js';
import { selectionSchema } from '../services/selection.js';

const cardTitle = z.string().trim().min(1, 'Give the card a name').max(200);
const createSchema = z.object({ title: cardTitle, selection: selectionSchema });
const updateSchema = z.object({ title: cardTitle.optional(), selection: selectionSchema.optional() });
const listQuery = z.object({ q: z.string().trim().max(100).optional() });

export const cardsRouter = Router();

// Working with an unsaved selection.

cardsRouter.post('/preview', validate(selectionSchema), async (req, res) => {
  res.json(await buildCard(req.valid.body));
});

cardsRouter.post('/pdf', validate(selectionSchema), async (req, res) => {
  await sendPdf(res, await buildCard(req.valid.body));
});

cardsRouter.post('/summary', validate(selectionSchema), async (req, res) => {
  res.json(await draftSummary(await buildCard(req.valid.body)));
});

// Saved card library.

cardsRouter.get('/', validate(listQuery, 'query'), async (req, res) => {
  res.json((await listCards(req.valid.query.q)).map(presentCard));
});

cardsRouter.post('/', validate(createSchema), async (req, res) => {
  res.status(201).json(presentCard(await createCard(req.valid.body, req.user)));
});

cardsRouter.get('/:id', validate(idParams, 'params'), async (req, res) => {
  res.json(presentCard(await getCard(req.valid.params.id)));
});

cardsRouter.put('/:id', validate(idParams, 'params'), validate(updateSchema), async (req, res) => {
  res.json(presentCard(await updateCard(req.valid.params.id, req.valid.body, req.user)));
});

cardsRouter.post('/:id/duplicate', validate(idParams, 'params'), async (req, res) => {
  res.status(201).json(presentCard(await duplicateCard(req.valid.params.id, req.user)));
});

cardsRouter.delete('/:id', validate(idParams, 'params'), async (req, res) => {
  await deleteCard(req.valid.params.id, req.user);
  res.status(204).end();
});

/** Re-render a saved card against current data. */
cardsRouter.get('/:id/pdf', validate(idParams, 'params'), async (req, res) => {
  const card = await getCard(req.valid.params.id);
  await sendPdf(res, await buildCard(parseStoredSelection(card.selection)));
});

async function sendPdf(res, card) {
  // Render fully before sending headers, so a failure returns an error, never an empty file.
  const pdf = await renderCardPdf(card);
  res.attachment(cardFilename(card)).set('Cache-Control', 'no-store').send(pdf);
}
