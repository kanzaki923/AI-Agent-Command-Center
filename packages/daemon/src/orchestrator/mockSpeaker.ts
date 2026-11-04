import type { MockCallInfo, MockReply } from '../llm/mock';
import type { ChatRequest } from '../llm/types';

/** Offline speaker (a child with a persona) for the demo, audits and tests. */
export const MOCK_SPEAKER_MODEL = 'mock/speaker';

const PERSONA = /<<<キャラここから>>>\n([\s\S]*?)\n<<<キャラここまで>>>/;
const REQUEST = /<<<依頼ここから>>>\n([\s\S]*?)\n<<<依頼ここまで>>>/;
const FORWARDED = /<<<「(.+?)」の発言ここから>>>/g;
const CAUTIOUS = /慎重|リスク|懸念|批判|辛口|現実|レビュ|疑/;

const EAGER = [
  (topic: string) =>
    `${topic}なら、まず小さく試せる形から始めたいです。週末だけの限定版を出して、反応を見てみませんか。`,
  (_: string, other: string) =>
    `${other}さんの心配はもっともです。だからこそ、費用のかからない申込フォームを先に作って、興味のある人の数を確かめましょう。`,
  () =>
    '決めましょう。来月の第 1 週に限定版を出し、申込が 50 件を超えたら本格的に進める。この線でどうでしょう。',
];

const PLAIN_SPEAKER = /使う側|利用者|ふつう|普通|率直/;

const PLAIN = [
  (topic: string) =>
    `${topic}、正直に言うと、毎月いくらなら頼むかで決まります。千円台なら試してみたいです。`,
  (_: string, other: string) =>
    `${other}さんの話はわかりやすかったです。ただ、解約が面倒そうだと申し込まないので、そこは簡単にしてほしいです。`,
  () => 'その形なら、まず 1 か月だけ頼んでみます。気に入ったら友だちにも勧めます。',
];

const CAREFUL = [
  (topic: string) =>
    `${topic}は面白いですが、続けるための費用と人手が気になります。最初に、誰がいくら払うのかを確かめたいです。`,
  (_: string, other: string) =>
    `${other}さんの案なら試す費用が小さいので賛成です。ただ、申込の数だけでなく、実際に払う人の割合も見ましょう。`,
  () =>
    'その条件なら賛成です。払う人が 1 割を切ったら止める、という撤退の線も一緒に決めておきましょう。',
];

/**
 * `mock/speaker`: plays the persona of its frame turn by turn. Eager or careful by the words
 * of the persona, it reacts by name to the first speaker passed on to it, and its turns move
 * from a first view to a concrete proposal, like a short meeting.
 */
export function mockSpeaker(req: ChatRequest, info: MockCallInfo): MockReply {
  const system = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (m as { content: string }).content)
    .join('\n');
  const persona = PERSONA.exec(system)?.[1] ?? '';
  const request = REQUEST.exec(system)?.[1] ?? info.lastUserText;
  const turn = Math.max(0, req.messages.filter((m) => m.role === 'user').length - 1);
  const other = [...info.lastUserText.matchAll(FORWARDED)][0]?.[1] ?? 'みなさん';
  const lines = linesFor(persona);
  const line = lines[Math.min(turn, lines.length - 1)]!;
  return { text: line(topicOf(request), other) };
}

function linesFor(persona: string) {
  if (CAUTIOUS.test(persona)) return CAREFUL;
  return PLAIN_SPEAKER.test(persona) ? PLAIN : EAGER;
}

/** 「新しい朝食サービス」について… → 新しい朝食サービス; else the first line, cut short. */
export function topicOf(request: string): string {
  const quoted = /「([^「」]+)」/.exec(request)?.[1];
  const raw = (quoted ?? request.split('\n')[0] ?? '').trim();
  const chars = [...raw];
  return chars.length > 20 ? `${chars.slice(0, 19).join('')}…` : raw || 'この案';
}
