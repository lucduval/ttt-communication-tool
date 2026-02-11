import { describe, it, expect, vi, afterEach } from 'vitest';
import { getClickatellConfig } from '../whatsapp';

describe('getClickatellConfig', () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });

    it('should return apiKey when environment variable is set', () => {
        process.env.CLICKATELL_API_KEY = 'test-api-key';
        const config = getClickatellConfig();
        expect(config).toEqual({ apiKey: 'test-api-key' });
    });

    it('should throw error when environment variable is missing', () => {
        delete process.env.CLICKATELL_API_KEY;
        expect(() => getClickatellConfig()).toThrow('Missing Clickatell configuration');
    });
});
