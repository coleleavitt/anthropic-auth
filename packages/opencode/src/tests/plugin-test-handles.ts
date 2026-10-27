import { enablePluginTestHandles } from '../plugin-test-handles'

const handles = enablePluginTestHandles()

export function getPluginTestHandles(plugin: object) {
  const handle = handles.get(plugin)
  if (!handle)
    throw new Error('Plugin was created without internal test handles')
  return handle
}
