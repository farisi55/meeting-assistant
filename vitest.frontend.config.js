import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'frontend',
    environment: 'jsdom',
    include: ['test/frontend/**/*.test.js'],
  },
});
