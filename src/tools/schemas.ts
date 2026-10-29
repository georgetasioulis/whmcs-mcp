import { z } from 'zod';

export const zId = z.number().int().positive();
export const zOffset = z.number().int().min(0).optional().describe('Starting offset for pagination (default: 0)');
export const zLimit = (fallback: number, max = 250) =>
  z.number().int().min(1).max(max).optional().describe(`Number of records to return (default: ${fallback}, max: ${max})`);
export const zText = z.string().min(1);
export const zPriority = z.enum(['Low', 'Medium', 'High']);
