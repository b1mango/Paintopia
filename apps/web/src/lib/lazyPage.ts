import { lazy, type ComponentType } from "react";

/**
 * 按页拆包的懒组件。模块一旦预载完成，lazy 拿到的是同步 thenable，
 * 切页时直接渲染、不再闪一下 Suspense 占位。
 */
export function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  let loaded: M | undefined;
  let pending: Promise<M> | undefined;
  const preload = () => (pending ??= load().then(module => (loaded = module)));
  const Component = lazy(() => {
    if (loaded) {
      const module = { default: loaded[name] as ComponentType<any> };
      return { then: (resolve: (value: typeof module) => void) => resolve(module) } as unknown as Promise<typeof module>;
    }
    return preload().then(module => ({ default: module[name] as ComponentType<any> }));
  }) as unknown as M[K];
  return Object.assign(Component as object, { preload }) as M[K] & { preload: () => Promise<M> };
}

/** 空闲时再预载，不与首屏争带宽。 */
export function whenIdle(task: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(task, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(task, 1200);
  return () => window.clearTimeout(id);
}
