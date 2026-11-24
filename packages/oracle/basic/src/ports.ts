import { Context } from "effect";
import type * as Naming from "./namer";

// Separate entry (`@folio/oracle-basic/ports`) because `Context.Service(...)` is a runtime value and the main entry is value-imported
// by client components; merging would put `effect` in the client bundle's reachable graph.
// Naming identity (id + curated table): the write path needs only this, not the network faces.
export type Namer = Naming.Namer;
export const Namer = Context.Service<Namer>("oracle/Namer");
