import { tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { NAMER } from "@/lib/server/oracle";

// Built with the production encoder so a change to the encoding rules can't silently desync tests.
export const ticketOf = (coinId: string) => tokenTicket.encode(tokenRef.issued(NAMER, coinId));
