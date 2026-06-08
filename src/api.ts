// Pure (no vscode) helpers: the OpenAI Responses call, response parsing, and the
// line-shift math. Kept separate so they can be unit-tested outside the host.

import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

export interface ConvertOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  src: string;
  key: string;
  effort?: string;
  previousResponseId?: string;
}

export interface ConvertResult {
  text: string;            // first line of the model's answer ('' if none)
  responseId?: string;     // for conversation chaining
}

export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      n++;
    }
  }
  return n;
}

// Net change in line count a single text edit causes, given the replaced range
// span (in lines) and the inserted text.
export function lineDelta(rangeStartLine: number, rangeEndLine: number, insertedText: string): number {
  return countNewlines(insertedText) - (rangeEndLine - rangeStartLine);
}

export function extractText(data: any): string {
  const out = (data && data.output) || [];
  for (const item of out) {
    if (item && item.type === 'message') {
      for (const part of item.content || []) {
        if (part && (part.type === 'output_text' || part.type === 'text')) {
          return (part.text || '').split('\n')[0];
        }
      }
    }
  }
  return '';
}

export function buildBody(o: ConvertOptions): any {
  const body: any = {
    model: o.model,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: o.prompt + o.src }] },
    ],
  };
  if (o.effort) {
    body.reasoning = { effort: o.effort };
  }
  if (o.previousResponseId) {
    body.previous_response_id = o.previousResponseId;
  }
  return body;
}

export async function convert(o: ConvertOptions): Promise<ConvertResult> {
  const baseUrl = (o.baseUrl || '').replace(/\/+$/, '');
  const data = await httpPostJson(`${baseUrl}/responses`, buildBody(o), o.key);
  if (data && data.error) {
    throw new Error(data.error.message || 'API error');
  }
  return { text: extractText(data), responseId: data && data.id };
}

export function httpPostJson(urlStr: string, body: any, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error('invalid baseUrl: ' + urlStr));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const mod = u.protocol === 'http:' ? http : https;
    const opts: https.RequestOptions = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': payload.length,
      },
    };
    const req = mod.request(opts, res => {
      const chunks: Buffer[] = [];
      res.on('data', d => chunks.push(d as Buffer));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error(`non-JSON response (${res.statusCode}): ${text.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
