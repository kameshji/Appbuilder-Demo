import { useEffect } from 'react'
import { bootstrap } from '@/runtime/store'
import { Studio } from '@/studio/Studio'

export default function App() {
  useEffect(() => {
    bootstrap()
  }, [])
  return <Studio />
}
