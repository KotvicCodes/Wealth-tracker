import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../lib/handler.js';

export default function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return handleApi('billionaires', req, res);
}
