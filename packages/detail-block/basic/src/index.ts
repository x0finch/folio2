// @folio/detail-block-basic —— DetailBlock 契约层(ADR 0010,词汇表 v1)。
// provider 专属、仅供展示的结构化块的 zod 判别联合 + 类型。React-free:
// provider(server)拼块、前端(@folio/detail-block)渲染,单一源、不漂移、不把 provider 运行时拖进客户端 bundle。
export * from "./detail-block";
