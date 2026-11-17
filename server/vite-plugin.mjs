// Vite plugin: mounts the workspace file API (same handler as server/index.mjs) as dev/preview middleware.
import { createFsHandler } from './handler.mjs'

export default function appbuilderFsPlugin() {
  const fsApi = createFsHandler()
  const mount = (server) => {
    server.middlewares.use((req, res, next) => {
      fsApi.handle(req, res).then(
        (handled) => {
          if (!handled) next()
        },
        (err) => next(err),
      )
    })
  }
  return {
    name: 'appbuilder-fs-api',
    configureServer: mount,
    configurePreviewServer: mount,
  }
}
