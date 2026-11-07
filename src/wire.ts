/**
 * `gitPanel` 远程服务的 wire 描述。
 *
 * 设计约定与 game-material-master 相同：每个方法只收一个 `payload` 对象
 * （无参方法则没有 payload），这样一份 manifest 就能同时被宿主网关和浏览器
 * 半区复用。schema 采用宽松的 identity codec —— 参数在宿主侧由业务代码
 * 自己校验，避免把插件内部的类型细节复制两份。
 */

export const PACKAGE_NAME = 'dsh-git-panel'
export const SERVICE_NAME = 'gitPanel'

export interface MethodSpec {
  method: string
  payload: boolean
}

/**
 * 浏览器半区可调用的方法清单。顺序也是工具面/界面提示的顺序。
 * 新增方法时三处必须同步：这里、src/index.ts 的类方法、src/client.ts 的
 * REMOTE_METHODS 与 api 包装。
 */
export const METHODS: MethodSpec[] = [
  { method: 'reportOrigin', payload: true },
  { method: 'getState', payload: true },
  { method: 'getDiff', payload: true },
  { method: 'listCommits', payload: true },
  { method: 'getCommit', payload: true },
  { method: 'listReviews', payload: true },
  { method: 'getReview', payload: true },
  { method: 'listPending', payload: false },
  { method: 'decideReview', payload: true }
]

function strictCodec(typeSymbol: string) {
  return {
    mode: 'strict' as const,
    typeSymbol,
    create: () => ({
      parse: (value: unknown) => value
    })
  }
}

/** 注册给宿主 typert 网关的 package face。 */
export const MANIFEST = {
  package: PACKAGE_NAME,
  face: 'host' as const,
  schemas: [] as unknown[],
  invocations: METHODS.map((spec) => ({
    id: `${PACKAGE_NAME}#${SERVICE_NAME}/${spec.method}`,
    service: SERVICE_NAME,
    namespace: SERVICE_NAME,
    method: spec.method,
    invocation: { kind: 'direct' as const },
    parameters: spec.payload
      ? [
          {
            name: 'payload',
            wire: 'payload',
            source: 'json' as const,
            codec: strictCodec(`${PACKAGE_NAME}#${spec.method}Payload`)
          }
        ]
      : [],
    result: strictCodec(`${PACKAGE_NAME}#${spec.method}Result`)
  })),
  model: { services: [], events: [], objects: [] }
}
