import {expect,it} from 'vitest';
import * as identity from '../../src/identity/service';
it('one shared name rule rejects controls and overlength before protected booking',()=>{
  const valid=(identity as any).isMeaningfulName;expect(typeof valid).toBe('function');
  expect(valid(' Тест ')).toBe(true);
  for(const name of ['', ' ', 'Bad\nName','Bad\u200bName','a'.repeat(81)])expect(valid(name)).toBe(false);
});
