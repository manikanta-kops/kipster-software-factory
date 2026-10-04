import { StrictMode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './queries.ts'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
