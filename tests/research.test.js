'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { marketExtract, lookupConfig } = require('../app/research');

const TEARSHEET = [
  '*Last Updated: November 15, 2026*',
  '',
  '# Market Screenshot',
  '',
  '## Global Markets',
  '*As of November 13, 2026*',
  '### Americas',
  '| United States | SPY | +10.62% |',
  '### Europe',
  '| Germany | EWG | +5.00% |',
  '## Equity Sectors',
  '*Source: FMP*',
  '### United States',
  '| Technology | XLK | +18.27% |',
  '## Currencies',
  '### Fiat Currencies',
  '| EUR/USD | +1.00% |',
  '## Equity Factors',
  '### Qualitative (Relative to S&P 500)',
  '| Quality | QUAL | +1.00% |',
  '### Style (Relative to S&P 500)',
  '| Growth | IWF | -13.53% |',
].join('\n');

test('marketExtract keeps the chosen sections with their part heading', () => {
  const text = marketExtract(TEARSHEET);
  for (const line of ['*Last Updated: November 15, 2026*', '## Global Markets', '*As of November 13, 2026*',
    '| United States | SPY | +10.62% |', '## Equity Sectors', '*Source: FMP*', '| Technology | XLK | +18.27% |',
    '## Equity Factors', '### Style (Relative to S&P 500)', '| Growth | IWF | -13.53% |']) {
    assert.ok(text.includes(line), line);
  }
});

test('marketExtract drops the other sections and parts', () => {
  const text = marketExtract(TEARSHEET);
  for (const line of ['### Europe', 'EWG', '## Currencies', 'EUR/USD', '### Qualitative', 'QUAL']) {
    assert.ok(!text.includes(line), line);
  }
  // A part heading is kept once, before its first kept section.
  assert.equal(text.match(/## Equity Factors/g).length, 1);
  assert.ok(text.indexOf('## Equity Factors') < text.indexOf('### Style'));
});

// Fake SDK client: answers each command by its class name.
const fakeClient = (answers) => ({
  async send(command) {
    const answer = answers[command.constructor.name];
    if (!answer) throw new Error(`unexpected ${command.constructor.name}`);
    return typeof answer === 'function' ? answer(command.input) : answer;
  },
});

const PROD_CLIENTS = {
  control: fakeClient({
    // Two pages, to check the pagination.
    ListHarnessesCommand: ({ nextToken }) => (nextToken
      ? { harnesses: [{ harnessName: 'datathon2026_equipe14_reviewer', arn: 'arn:reviewer' }] }
      : {
        harnesses: [
          { harnessName: 'datathon2026_equipe14_andre_research', arn: 'arn:andre' },
          { harnessName: 'datathon2026_equipe14_research', arn: 'arn:research' },
        ],
        nextToken: 'page2',
      }),
    ListGatewaysCommand: { items: [
      { name: 'datathon2026-equipe14-andre-research', gatewayId: 'gw-andre' },
      { name: 'datathon2026-equipe14-research', gatewayId: 'gw-prod' },
    ] },
    GetGatewayCommand: ({ gatewayIdentifier }) => ({ gatewayUrl: `https://${gatewayIdentifier}/mcp` }),
  }),
  agent: fakeClient({
    ListKnowledgeBasesCommand: { knowledgeBaseSummaries: [{ name: 'datathon2026-equipe14-earnings', knowledgeBaseId: 'KB1' }] },
    ListDataSourcesCommand: ({ knowledgeBaseId }) => ({ dataSourceSummaries: [{ dataSourceId: `DS-${knowledgeBaseId}` }] }),
    GetDataSourceCommand: { dataSource: { dataSourceConfiguration: { managedKnowledgeBaseConnectorConfiguration: {
      connectorParameters: JSON.stringify({ connectionConfiguration: { bucketName: 'earnings-bucket' } }),
    } } } },
  }),
};

test('lookupConfig finds the agents of an environment by name', async () => {
  assert.deepEqual(await lookupConfig('datathon2026-equipe14', PROD_CLIENTS), {
    harnessArn: 'arn:research',
    reviewerArn: 'arn:reviewer',
    gatewayUrl: 'https://gw-prod/mcp',
    kb: { bucket: 'earnings-bucket', id: 'KB1', dataSourceId: 'DS-KB1' },
  });
});

test('lookupConfig leaves everything empty for an environment without agents', async () => {
  assert.deepEqual(await lookupConfig('datathon2026-equipe14-lucas', PROD_CLIENTS), {
    harnessArn: '', reviewerArn: '', kb: {},
  });
});