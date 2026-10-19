import { desc, eq, or } from "drizzle-orm";
import type { Repo } from "../../db/repo.js";
import {
  conversationMessages,
  favorites,
  listings,
  meetings,
  offers,
  orders,
  reviews,
  savedSearches,
  shops,
  stolenReports,
  type User,
} from "../../db/schema.js";

/**
 * «Скачать мои данные» (stage 29): everything Ishonch keeps about the person, as one JSON document. Only their own
 * data: in orders where they sold, the buyer's address and phone are left out; other people stay ids.
 */
export async function buildExport(repo: Repo, user: User) {
  const db = repo.db;
  const [myListings, myOrders, myReviews, mySearches, myFavorites, myMessages, myOffers, myMeetings, myShop, myReports] = await Promise.all([
    db
      .select({
        id: listings.id,
        status: listings.status,
        category: listings.category,
        titleRu: listings.titleRu,
        titleUz: listings.titleUz,
        descriptionRu: listings.descriptionRu,
        descriptionUz: listings.descriptionUz,
        price: listings.price,
        condition: listings.condition,
        imei: listings.imei,
        district: listings.district,
        publishedAt: listings.publishedAt,
        soldAt: listings.soldAt,
        createdAt: listings.createdAt,
      })
      .from(listings)
      .where(eq(listings.sellerUserId, user.id))
      .orderBy(desc(listings.createdAt)),
    db
      .select()
      .from(orders)
      .where(or(eq(orders.buyerUserId, user.id), eq(orders.sellerUserId, user.id)))
      .orderBy(desc(orders.createdAt)),
    db
      .select()
      .from(reviews)
      .where(or(eq(reviews.buyerUserId, user.id), eq(reviews.sellerUserId, user.id))),
    db.select().from(savedSearches).where(eq(savedSearches.userId, user.id)),
    db.select({ listingId: favorites.listingId, createdAt: favorites.createdAt }).from(favorites).where(eq(favorites.userId, user.id)),
    db
      .select({ conversationId: conversationMessages.conversationId, text: conversationMessages.text, createdAt: conversationMessages.createdAt })
      .from(conversationMessages)
      .where(eq(conversationMessages.senderUserId, user.id))
      .orderBy(desc(conversationMessages.createdAt)),
    db
      .select({ listingId: offers.listingId, kind: offers.kind, amount: offers.amount, status: offers.status, createdAt: offers.createdAt })
      .from(offers)
      .where(eq(offers.buyerUserId, user.id)),
    db
      .select()
      .from(meetings)
      .where(or(eq(meetings.buyerUserId, user.id), eq(meetings.sellerUserId, user.id))),
    db.select().from(shops).where(eq(shops.ownerUserId, user.id)),
    db.select().from(stolenReports).where(eq(stolenReports.userId, user.id)),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    profile: {
      id: user.id,
      telegramId: user.telegramId,
      language: user.language,
      phone: user.phone,
      registeredAt: user.createdAt,
      acceptedTermsAt: user.acceptedTermsAt,
      notificationsOff: user.notifyOff,
      awayUntil: user.awayUntil,
    },
    shop: myShop[0] ? { name: myShop[0].name, marketLocation: myShop[0].marketLocation, verified: myShop[0].verified, createdAt: myShop[0].createdAt } : null,
    listings: myListings,
    orders: myOrders.map((o) => {
      const asBuyer = o.buyerUserId === user.id;
      return {
        id: o.id,
        role: asBuyer ? "buyer" : "seller",
        listingId: o.listingId,
        status: o.status,
        mode: o.mode,
        quote: o.quote,
        district: o.district,
        // The address belongs to the buyer: the seller's copy leaves it out.
        ...(asBuyer ? { address: o.address, comment: o.comment } : {}),
        createdAt: o.createdAt,
        deliveredAt: o.deliveredAt,
      };
    }),
    reviews: {
      written: myReviews.filter((r) => r.buyerUserId === user.id).map((r) => ({ orderId: r.orderId, rating: r.rating, text: r.text, createdAt: r.createdAt })),
      received: myReviews.filter((r) => r.sellerUserId === user.id).map((r) => ({ orderId: r.orderId, rating: r.rating, text: r.text, createdAt: r.createdAt })),
    },
    savedSearches: mySearches.map((s) => ({ title: s.title, filters: s.filters, shownToSellers: s.public, createdAt: s.createdAt })),
    favorites: myFavorites,
    messagesSent: myMessages,
    offersMade: myOffers,
    meetings: myMeetings.map((m) => ({
      role: m.buyerUserId === user.id ? "buyer" : "seller",
      listingId: m.listingId,
      spot: m.spot,
      place: m.place,
      at: m.at,
      status: m.status,
      createdAt: m.createdAt,
    })),
    stolenReports: myReports.map((r) => ({ imei: r.imei, kind: r.kind, policeReport: r.policeReport, createdAt: r.createdAt, withdrawnAt: r.withdrawnAt })),
  };
}
