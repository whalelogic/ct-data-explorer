import rateLimit from 'express-rate-limit';

// Guest chat and report summaries share a per-network budget. Use the default
// IP key so changing the session cookie or IPv6 host address doesn't reset it.
export const guestAiLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 10,
  skip: (request) => Boolean(request.user),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'This network has reached the guest AI limit. Wait a few minutes and try again.' },
});
