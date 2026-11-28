/** The QQ connection that replies go through; one Source kind watches and sends on the same connection. */
export interface QqSender { send(address: Record<string, string>, text: string): Promise<void> }

let current: QqSender | undefined

/** Installs the live connection for outbound replies, replacing (and so retiring) any previous one. */
export function setQqSender(sender: QqSender): void { current = sender }
/** Retires `sender` only if it is still installed, so a stopped connection cannot clear its replacement. */
export function clearQqSender(sender: QqSender): void { if (current === sender) current = undefined }
/** Reads a QQ channel address back into the fields OneBot and roost-host calls need. */
export function qqAddressFields(address: Record<string, string>): { chatKind: 'group' | 'private'; chatId: string; providerKind: string } {
  const chatId = address.chatId ?? ''
  if (!chatId) throw new Error('The QQ address names no chat')
  const chatKind = address.chatKind === 'group' ? 'group' : 'private'
  return { chatKind, chatId, providerKind: address.providerKind || chatKind }
}
/** Sends one reply on the installed connection; throws while no connection is live so the Outbox retries later. */
export async function sendQq(address: Record<string, string>, text: string): Promise<'sent' | 'gone'> {
  const sender = current
  if (!sender) throw new Error('The QQ Source is not connected; the reply will be retried')
  await sender.send(address, text)
  return 'sent'
}
