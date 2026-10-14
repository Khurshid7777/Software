import type { Order } from "../../db/schema.js";

export interface ShipmentParty {
  phone: string | null;
  district: string | null;
  address: string | null;
}

export interface ShipmentRequest {
  order: Order;
  pickup: ShipmentParty;
  dropoff: ShipmentParty;
  /** Cash the courier must collect from the buyer (COD), UZS; 0 for delivery only. */
  collectUzs: number;
  itemTitle: string;
}

/**
 * Courier integration. The MVP has only ManualProvider (operators book couriers themselves and move
 * statuses with the bot buttons). A real service (Yandex Delivery, local couriers' API) implements
 * the same interface and reports statuses back through OrderService.operatorSetStatus.
 */
export interface CourierProvider {
  readonly name: string;
  /** Called when the seller confirms the order. Returns the provider's shipment id, if any. */
  createShipment(req: ShipmentRequest): Promise<{ externalId: string | null }>;
  cancelShipment(order: Order): Promise<void>;
}

export class ManualProvider implements CourierProvider {
  readonly name = "manual";

  async createShipment() {
    // Nothing to call: the operators' chat gets the order card (OrderService), a person books the courier.
    return { externalId: null };
  }

  async cancelShipment() {}
}

export function createCourierProvider(name: "manual"): CourierProvider {
  switch (name) {
    case "manual":
      return new ManualProvider();
  }
}
