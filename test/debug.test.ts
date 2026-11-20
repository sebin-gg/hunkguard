import { it, expect } from 'vitest';
import * as fs from 'fs';
import { buildProposal, applySelectedHunks } from '../src/diff/proposal';

it('debug real helpers.py', () => {
  const content = fs.readFileSync('D:/git/flask/src/flask/helpers.py', 'utf8');
  const lines = content.split('\n');
  const start = lines.findIndex(l => l.startsWith('def get_debug_flag'));
  const end = lines.findIndex((l, i) => i > start && l.includes('not in {'));
  const oldStr = lines.slice(start, end + 1).join('\n');
  console.log('OLD>>>', JSON.stringify(oldStr.slice(0, 200)));
  const newStr = oldStr
    .replace('The default is ``False``.', 'The default is ``False``. The values ``"0"``, ``"false"``, ``"no"``, ``"off"`` and ``"n"`` are treated as false.')
    .replace('{"0", "false", "no"}', '{"0", "false", "no", "off", "n"}');
  const r = buildProposal('dbg', 't', 'src/flask/helpers.py', content, [{ old_string: oldStr, new_string: newStr }]);
  console.log('err', r.error, 'hunks', r.proposal?.hunks.length);
  const h = r.proposal!.hunks[0];
  console.log('hunk0', JSON.stringify({oldStart:h.oldStart, oldLines:h.oldLines, nlines:h.lines.length}).slice(0,200));
  const res = applySelectedHunks(content, [h]);
  console.log('res keys', Object.keys(res), 'stale', res.staleHunkIds, 'hasContent', !!res.content);
  expect(res.content).toBeTruthy();
});
