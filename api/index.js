// Vercel entry point. Every /api/* request is rewritten here (see vercel.json).
import { handle } from '../src/app.js';

export default function handler(req, res) {
  return handle(req, res);
}
