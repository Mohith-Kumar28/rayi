import { setupWorker } from 'msw/browser';
import { handlers } from '@rayi/api-client/mocks';

export const worker = setupWorker(...handlers);
