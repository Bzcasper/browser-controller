import { describe, it, expect } from 'vitest';

const { cdpEvaluate } = await import('../extension/lib/cdp-evaluate.js');

type Reply = Record<string, unknown>;
function fakeSend(evalReply: Reply | (() => Promise<Reply>), serialized?: string) {
  const calls: Array<{ method: string; params: Reply }> = [];
  const send = async (method: string, params: Reply = {}) => {
    calls.push({ method, params });
    if (method === 'Runtime.evaluate') return typeof evalReply === 'function' ? evalReply() : evalReply;
    if (method === 'Runtime.callFunctionOn') return { result: { value: serialized } };
    return {};
  };
  return { send, calls };
}

describe('cdpEvaluate (REPL mode)', () => {
  it('uses replMode + awaitPromise and returns primitives directly', async () => {
    const { send, calls } = fakeSend({ result: { type: 'number', value: 5 } });
    expect(await cdpEvaluate(send, 'await 2; 5')).toEqual({ success: true, result: 5 });
    expect(calls[0].params).toMatchObject({ replMode: true, awaitPromise: true, userGesture: true });
    expect(calls.at(-1)!.method).toBe('Runtime.releaseObjectGroup');
  });

  it('serializes objects page-side', async () => {
    const { send } = fakeSend({ result: { type: 'object', objectId: 'o1' } }, '{"a":[1,"<input#x>"]}');
    expect(await cdpEvaluate(send, '({a:[1,el]})')).toEqual({ success: true, result: { a: [1, '<input#x>'] } });
  });

  it('describes DOM nodes', async () => {
    const { send } = fakeSend({ result: { type: 'object', subtype: 'node', objectId: 'n', description: 'input#a' } });
    expect(await cdpEvaluate(send, 'document.activeElement')).toEqual({ success: true, result: 'input#a' });
  });

  it('reports undefined, NaN and exceptions', async () => {
    expect(await cdpEvaluate(fakeSend({ result: { type: 'undefined' } }).send, 'void 0'))
      .toMatchObject({ success: true, result: null, type: 'undefined' });
    expect(await cdpEvaluate(fakeSend({ result: { type: 'number', unserializableValue: 'NaN' } }).send, 'NaN'))
      .toEqual({ success: true, result: 'NaN' });
    const err = await cdpEvaluate(fakeSend({ result: {}, exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } } }).send, 'x');
    expect(err).toEqual({ success: false, error: 'ReferenceError: x is not defined' });
  });

  it('times out on a promise that never settles', async () => {
    const { send } = fakeSend(() => new Promise(() => {}));
    const res = await cdpEvaluate(send, 'await new Promise(()=>{})', { timeoutMs: 1000 });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/did not finish within 1000ms/);
  });
});
