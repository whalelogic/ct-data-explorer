/** The data assistant chat (services/ai/assistant.js). Signed-in users only; CSRF-protected. */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { askAssistant } from '../services/ai/assistant.js';

const MAX_TURNS = 30;
const MAX_TURN_LENGTH = 4000;

// Each message can run several model calls, so the limit is per person and generous but firm.
const assistantLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  keyGenerator: (request) => `user:${request.user.id}`,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'You’ve sent a lot of questions in a short time. Wait a few minutes and try again.' },
});

const turn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(MAX_TURN_LENGTH, `Keep each message under ${MAX_TURN_LENGTH} characters`),
});

const chatSchema = z.object({
  messages: z.array(turn).min(1).max(MAX_TURNS, 'This conversation is long. Start a new one to keep going.')
    .refine((messages) => messages[0].role === 'user' && messages.at(-1).role === 'user', 'The conversation must start and end with your message'),
  // What the person is looking at. Only short, typed facts are accepted; nothing here is trusted as an instruction.
  context: z.object({
    page: z.enum(['dashboard', 'builder', 'dataset', 'reports', 'report', 'admin', 'other']).optional(),
    datasetId: z.number().int().positive().optional(),
    selection: z.object({
      compareBy: z.string().max(20).optional(),
      rows: z.array(z.string().max(500)).max(2000).optional(),
      allRows: z.boolean().optional(),
      indicators: z.array(z.string().max(100)).max(50).optional(),
    }).optional(),
  }).default({}),
});

export const assistantRouter = Router();

assistantRouter.post('/', assistantLimiter, validate(chatSchema), async (request, response) => {
  const { messages, context } = request.valid.body;
  response.json(await askAssistant(messages, context, request.user));
});
