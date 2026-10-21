// Checkout implementation (fixture).

export interface PaymentGateway {
  authorize(amountCents: number): Promise<string>;
  capture(authorizationId: string): Promise<void>;
}

/** Realizes the two-step strategy: authorize first, capture after confirmation. */
export async function checkout(
  gateway: PaymentGateway,
  amountCents: number,
  orderConfirmed: boolean
): Promise<void> {
  const authorizationId = await gateway.authorize(amountCents);
  if (!orderConfirmed) return;
  await gateway.capture(authorizationId);
}
