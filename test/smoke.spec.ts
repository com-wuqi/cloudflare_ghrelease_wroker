import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('serves robots.txt', async () => {
    const response = await SELF.fetch('https://dl.example.com/robots.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Disallow: /');
  });
});
