import type { Database } from './client';
import { deliveries } from './schema/deliveries';
import type { Delivery } from './schema/deliveries';
import { messages } from './schema/messages';
import type { Message } from './schema/messages';

export interface CreateInboundMessageInput {
  conversationId: string;
  clientMessageId: string;
  body: string;
  replyToMessageId?: string | null;
  source?: string;
}

export interface InboundMessageWithDelivery {
  message: Message;
  delivery: Delivery;
}

/**
 * Persists an inbound conversation message and its durable delivery record in a
 * single transaction. This is the storage primitive the M3 message endpoint will
 * use; it deliberately leaves HTTP idempotency responses to that endpoint.
 */
export async function createInboundMessageWithDelivery(
  database: Database,
  input: CreateInboundMessageInput,
): Promise<InboundMessageWithDelivery> {
  return database.transaction(async (transaction) => {
    const [message] = await transaction
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        direction: 'inbound',
        clientMessageId: input.clientMessageId,
        body: input.body,
        replyToMessageId: input.replyToMessageId ?? null,
        source: input.source ?? 'web',
      })
      .returning();

    if (!message) {
      throw new Error('message insert returned no row');
    }

    const [delivery] = await transaction
      .insert(deliveries)
      .values({ messageId: message.id })
      .returning();

    if (!delivery) {
      throw new Error('delivery insert returned no row');
    }

    return { message, delivery };
  });
}
