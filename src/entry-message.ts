// Match the complete standalone message; greetings, captions and extra text do
// not authorize automatic conversation. Only the individual number varies.
export function entryCode(text: string): string | null {
  return /^Обязательно отправьте это сообщение и дождитесь ответа\. Ваш номер: (rv-\d+)$/u.exec(text.trim())?.[1] ?? null;
}
