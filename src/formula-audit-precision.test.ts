import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFormulas, type FormulaSource } from './formula-audit.ts';

const R = String.raw;
const samples = R`实施例中，$\delta_2=36\%$、$\delta_3=18\%$、$\delta_7=10\%$。`;
const bands = R`所述第一阈值区间为 $5\%\le\delta_i<15\%$，所述第二阈值区间为 $15\%\le\delta_i<36\%$，所述第三阈值区间为 $\delta_i\ge36\%$。`;

function audit(claim: string, description: string) {
  const sources: FormulaSource[] = [
    { part: '权利要求书', where: '权利要求1', text: claim },
    { part: '具体实施方式', where: '具体实施方式', text: description },
  ];
  return auditFormulas(sources);
}

test('named classification bands do not constrain all indexed samples', () => {
  const report = audit(bands, samples);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-range'), []);
});

test('piecewise classification decisions are not universal embodiment ranges', () => {
  const classification = R`按偏差率判定等级：$\delta_i<5\%$判为无堵塞；$5\%\le\delta_i<15\%$判为轻度堵塞；$15\%\le\delta_i<36\%$判为中度堵塞；$\delta_i\ge36\%$判为重度堵塞。`;
  const report = audit('', classification + samples);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-range'), []);
});

test('conditional classification clauses are not limits on other samples', () => {
  const report = audit(R`当 $5\%\le\delta_i<15\%$ 时，判定为轻度堵塞。`, samples);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-range'), []);
});

test('an example falling in a named band does not constrain other examples', () => {
  for (const membership of [
    R`$\delta_3=18\%$，落在 $15\%\le\delta_3<36\%$ 的第二阈值区间内，判为中度堵塞。`,
    R`$\delta_3=18\%$，落在第二阈值区间 $15\%\le\delta_3<36\%$ 内，判为中度堵塞。`,
  ]) {
    const report = audit('', membership + samples);
    assert.deepEqual(report.issues.filter(item => item.id === 'formula-range'), []);
  }
});

test('a named claim interval rejects a different embodiment boundary', () => {
  const report = audit(bands, R`$\delta_3=18\%$，落在 $15\%\le\delta_3<30\%$ 的第二阈值区间内。` + samples);
  const conflicts = report.issues.filter(item => item.id === 'formula-range' && item.level === 'error');
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].detail, /第二阈值区间/);
  assert.match(conflicts[0].detail, /30%/);
  assert.match(conflicts[0].detail, /36%/);
  assert.ok(conflicts[0].where.includes('权利要求1'));
  assert.ok(conflicts[0].where.includes('具体实施方式'));
  assert.doesNotMatch(conflicts[0].detail, /δ_2=36%|δ_7=10%/);
});

test('a named interval before the embodiment inequality is checked against its claim definition', () => {
  const report = audit(bands, R`落在第二阈值区间 $10\%\le\delta_3<36\%$ 内。`);
  assert.ok(report.issues.some(item => item.id === 'formula-range' && item.level === 'error' && item.detail.includes('第二阈值区间')));
});

test('a one-sided named claim interval also rejects a different boundary', () => {
  const report = audit(bands, R`$\delta_2=36\%$，落在 $\delta_i\ge30\%$ 的第三阈值区间内。`);
  const conflicts = report.issues.filter(item => item.id === 'formula-range' && item.level === 'error');
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].detail, /第三阈值区间/);
});

test('matching named boundaries allow different indexed samples', () => {
  const report = audit(bands, R`落在 $15\%\le\delta_3<36\%$ 的第二阈值区间内；落在第三阈值区间 $\delta_2\ge36\%$ 内。` + samples);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-range'), []);
});

test('named boundary comparison ignores unnamed bands and unrelated names or symbols', () => {
  for (const description of [
    R`$15\%\le\delta_3<30\%$ 判为中度堵塞。`,
    R`落在 $15\%\le\delta_3<30\%$ 的第四阈值区间内。`,
    R`落在 $15\%\le T_3<30\%$ 的第二阈值区间内。`,
    R`落在 $15\mathrm{cm}\le\delta_3<30\mathrm{cm}$ 的第二阈值区间内。`,
  ]) {
    assert.deepEqual(audit(bands, description).issues.filter(item => item.id === 'formula-range'), []);
  }
});

test('named boundaries need one unambiguous numeric claim definition', () => {
  const description = R`第二阈值区间为 $15\%\le\delta_i<36\%$。落在 $15\%\le\delta_3<30\%$ 的第二阈值区间内。`;
  assert.deepEqual(audit('', description).issues.filter(item => item.id === 'formula-range'), []);
  const ambiguous = bands + R`第二阈值区间为 $15\%\le\delta_i<40\%$。`;
  assert.deepEqual(audit(ambiguous, description).issues.filter(item => item.id === 'formula-range'), []);
});

test('named interval definitions preserve open versus closed endpoints', () => {
  const report = audit(bands, R`落在 $15\%\le\delta_3\le36\%$ 的第二阈值区间内。`);
  assert.ok(report.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
});

test('a universal bound in the same paragraph as classification bands still applies', () => {
  const report = audit(bands + R`所有样本必须满足 $0\%\le\delta_i\le100\%$。`, samples + R`另一样本为 $\delta_9=150\%$。`);
  const conflicts = report.issues.filter(item => item.id === 'formula-range' && item.level === 'error');
  assert.ok(conflicts.some(item => item.detail.includes('150%') && item.detail.includes('100%')));
  assert.equal(conflicts.length, 1);
});

test('ordinary indexed bounds and named quantity ranges retain real conflicts', () => {
  const indexed = audit(R`$R_i$的取值范围为0.6～0.8。`, R`$R_1=0.2$。`);
  assert.ok(indexed.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
  const named = audit(R`分层厚度为10～30 cm。`, R`$d_i$为分层厚度。$d_2=50$ cm。`);
  assert.ok(named.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
});

test('a threshold variable range is still binding when it is not a classification band', () => {
  const report = audit(R`设计阈值 $T$ 的取值范围为5%～15%。`, R`实施例取 $T=20\%$。`);
  assert.ok(report.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
});

test('a named universal bound is not deduplicated against an equal classification band', () => {
  const report = audit(
    R`$\delta_i$为流量偏差率。第一阈值区间为 $5\%\le\delta_i<15\%$；流量偏差率为5%～15%。`,
    R`实施例中 $\delta_2=36\%$。`,
  );
  assert.ok(report.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
});

test('an explicit universal requirement remains binding even when followed by a classification label', () => {
  const report = audit(R`所有样本必须满足 $0\%\le\delta_i\le100\%$，判为有效测量。`, R`$\delta_2=150\%$。`);
  assert.ok(report.issues.some(item => item.id === 'formula-range' && item.level === 'error'));
});

test('是否 is not an explicit symbol definition', () => {
  const report = audit(R`$k_i$为第$i$个分区的补偿系数。`, R`判断更新后的 $k_i(n+1)$ 是否超出由响应表确定的可达上限 $k_{i,\max}$。`);
  assert.equal(report.symbols.some(item => item.key === 'k_i' && item.meaning.startsWith('否')), false);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-symbol-conflict'), []);
});

test('controller actions are not term-style symbol definitions', () => {
  const report = audit('', R`输入为第3分区的流量 $q_3$。控制器将 $q_3$ 与流量下限 $q_{\min}$ 比较。`);
  assert.ok(report.symbols.some(item => item.key === 'q_3' && item.meaning === '流量'));
  assert.equal(report.symbols.some(item => item.key === 'q_3' && item.meaning === '控制器'), false);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-symbol-conflict'), []);
});

test('clamping instructions do not redefine a named upper bound', () => {
  const report = audit('', R`由响应表确定的可达上限 $k_{i,\max}$，超出时取 $k_{i,\max}$。`);
  assert.ok(report.symbols.some(item => item.meaning === '可达上限'));
  assert.equal(report.symbols.some(item => item.meaning === '超出时取'), false);
  assert.deepEqual(report.issues.filter(item => item.id === 'formula-symbol-conflict'), []);
});

test('a meaning assigned to a compound denominator does not redefine its last operand', () => {
  const definition = R`$q_{i0}$为第$i$个分区清洁状态下的基准流量。`;
  for (const compound of [R`0.10\times q_{i0}`, R`0.10\cdot q_{i0}`, R`Q/q_{i0}`]) {
    const report = audit(definition, '分母 $' + compound + '$ 为按线性近似计算的流量增量基准。');
    assert.equal(report.symbols.some(item => item.key === 'q_i0' && item.meaning.includes('增量基准')), false);
    assert.deepEqual(report.issues.filter(item => item.id === 'formula-symbol-conflict'), []);
  }
});

test('using a quantity as a reference is not an explicit redefinition', () => {
  const report = audit(R`$q_3$为第3分区的流量。`, R`控制器以 $q_3$ 为反馈量。`);
  assert.equal(report.symbols.some(item => item.key === 'q_3' && item.meaning === '反馈量'), false);
});

test('genuine direct redefinitions remain errors', () => {
  const report = audit(R`$q_{i0}$为第$i$个分区清洁状态下的基准流量。`, R`$q_{i0}$为按线性近似计算的流量增量基准。`);
  assert.ok(report.issues.some(item => item.id === 'formula-symbol-conflict' && item.level === 'error' && item.detail.includes('q_i0')));
});

test('Markdown bullet definitions still expose real meaning conflicts', () => {
  const report = audit(R`- $K_s$为水分胁迫系数。`, R`- $K_s$为饱和导水率。`);
  assert.ok(report.issues.some(item => item.id === 'formula-symbol-conflict' && item.level === 'error'));
});

test('standalone definitions and genuine term conflicts are retained', () => {
  const explicit = audit('', R`设 $k_i$ 为补偿系数。$a_i$是控制增益。`);
  assert.ok(explicit.symbols.some(item => item.key === 'k_i' && item.meaning === '补偿系数'));
  assert.ok(explicit.symbols.some(item => item.key === 'a_i' && item.meaning === '控制增益'));
  const terms = audit('', R`流量 $q_3$，压力 $q_3$。`);
  assert.ok(terms.issues.some(item => item.id === 'formula-symbol-conflict' && item.level === 'warn'));
});
