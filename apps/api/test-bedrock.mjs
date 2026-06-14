import { readFileSync, writeFileSync } from 'node:fs';

const env = readFileSync('../../infra/aws/AWS.ENV', 'utf8');
const m = env.match(/AWS_BEARER_TOKEN_BEDROCK\s*=\s*(.+)/);
const token = m ? m[1].trim() : '';
const region = process.env.BEDROCK_REGION ?? 'us-east-1';

const modelId = 'us.anthropic.claude-opus-4-6-v1';
const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`;
const body = JSON.stringify({
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
});

let out = '';
try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body,
  });
  out = `region: ${region}\nstatus: ${res.status}\nbody: ${(await res.text()).slice(0, 400)}`;
} catch (e) {
  out = `FETCH ERROR: ${e.message}`;
}
writeFileSync('bedrock-result.txt', out);
