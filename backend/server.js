const express = require('express')
const cors = require('cors')
const { NdmiService } = require('./ndmiService')

const app = express()
const port = Number(process.env.PORT || 4000)
const ndmiService = new NdmiService()

app.use(cors())
app.use(express.json())

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    service: 'ndmi-live-alerts',
    timestamp: new Date().toISOString(),
  })
})

app.get('/api/ndmi-alerts', async (_, res) => {
  const snapshot = ndmiService.getSnapshot()

  if (snapshot.status === 'idle') {
    ndmiService.refresh().catch(() => {})
    res.status(202).json({
      ...snapshot,
      status: 'loading',
    })
    return
  }

  res.json(snapshot)
})

app.post('/api/ndmi-alerts/refresh', async (_, res) => {
  try {
    const fresh = await ndmiService.refresh()
    res.json(fresh)
  } catch (error) {
    res.status(500).json({
      ...ndmiService.getSnapshot(),
      error: error.message,
    })
  }
})

app.listen(port, () => {
  ndmiService.startAutoRefresh()
  console.log(`NDMI alert backend listening on http://localhost:${port}`)
})
