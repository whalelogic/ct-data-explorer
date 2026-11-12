/**
 * Per-person request limits for signed-in routes. They are keyed by user id rather
 * than IP address, because a whole office usually shares one address.
 *
 * Counters live in this process's memory, which is right for a single app container.
 * Running several replicas needs a shared store (see express-rate-limit's stores).
 */
import rateLimit from 'express-rate-limit';

/**
 * @param {{ windowMinutes: number, limit: number, message: string }} options
 */
export function perUserLimiter({ windowMinutes, limit, message }) {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    keyGenerator: (request) => `user:${request.user.id}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: message },
  });
}

/** A ceiling on everything a signed-in person can send; ordinary use never reaches it. */
export const apiLimiter = perUserLimiter({
  windowMinutes: 1,
  limit: 600,
  message: 'You’re sending requests too quickly. Wait a minute and try again.',
});

/** PDF rendering is the most CPU-heavy thing the server does. */
export const pdfLimiter = perUserLimiter({
  windowMinutes: 10,
  limit: 60,
  message: 'You’ve exported a lot of PDFs in a short time. Wait a few minutes and try again.',
});

/** Each draft is a paid model call. */
export const summaryLimiter = perUserLimiter({
  windowMinutes: 10,
  limit: 20,
  message: 'You’ve drafted a lot of summaries in a short time. Wait a few minutes, or write the text by hand.',
});

/** Uploads hold up to 10 MB in memory while they are parsed. */
export const uploadLimiter = perUserLimiter({
  windowMinutes: 10,
  limit: 60,
  message: 'You’ve uploaded a lot of files in a short time. Wait a few minutes and try again.',
});
