// Upstream beUI (tooltip) reads `process.env.NODE_ENV`; declare only its type to avoid pulling in @types/node.
declare const process: { env: { NODE_ENV?: string } };
