// Vite plugin: mounts the Appbuilder API (/api/v1, same handler as server/main.ts) as dev/preview middleware.
// The server core is TypeScript loaded natively by Node (type stripping) on the first /api request, so
// merely loading the Vite config (vite, vitest) has no side effects.
export default function appbuilderApiPlugin() {
  let app = null
  const getApp = () => {
    app ??= import(new URL('./core/app.ts', import.meta.url).href).then((m) => m.createApp())
    return app
  }
  const mount = (server) => {
    server.middlewares.use((req, res, next) => {
      const url = req.url ?? '/'
      if (!(url === '/api' || url.startsWith('/api/') || url.startsWith('/api?'))) return next()
      getApp()
        .then((a) => a.handle(req, res))
        .then(
          (handled) => {
            if (!handled) next()
          },
          (err) => next(err),
        )
    })
    // the realtime endpoint (WebSocket /api/v1/live) on the same server; Vite's own HMR socket is left alone
    server.httpServer?.on('upgrade', (req, socket, head) => {
      const url = req.url ?? ''
      if (url !== '/api/v1/live' && !url.startsWith('/api/v1/live?')) return
      getApp().then(
        (a) => {
          if (!a.handleUpgrade(req, socket, head)) socket.destroy()
        },
        () => socket.destroy(),
      )
    })
    server.httpServer?.once('close', () => {
      if (app) app.then((a) => a.close()).catch(() => {})
    })
  }
  return {
    name: 'appbuilder-api',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}
