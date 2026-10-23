const cheerio = require('cheerio')
const pdfParse = require('pdf-parse')

const NDMI_REPORT_URL = 'https://ndmindia.mha.gov.in/ndmi/report'
const NDMI_BASE_URL = 'https://ndmindia.mha.gov.in'
const REFRESH_INTERVAL_MS = 15 * 60 * 1000
const FETCH_TIMEOUT_MS = 15000

const HIGH_RISK_TERMS = [
  'severe flood',
  'extremely heavy rainfall',
  'red warning',
  'landslide',
  'dam overflow',
  'above danger level',
  'cyclone',
  'evacuation',
  'casualties',
  'deep depression',
  'cloud burst',
]

const MEDIUM_RISK_TERMS = [
  'heavy rainfall',
  'very heavy rainfall',
  'orange warning',
  'rising',
  'waterlogging',
  'thunderstorm',
  'flood situation',
]

function toAbsoluteUrl(url) {
  if (!url) return null
  if (url.startsWith('http')) return url
  return `${NDMI_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

function splitDistrictList(value) {
  return normalizeText(value)
    .replace(/\([^)]*\)/g, '')
    .split(/,| and /i)
    .map((item) => item.replace(/[^A-Za-z.\-'\s]/g, '').trim())
    .filter((item) => item && item.length > 2)
}

function titleCaseHazard(value) {
  return value
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function classifyRisk(text) {
  const lower = normalizeText(text).toLowerCase()
  if (HIGH_RISK_TERMS.some((term) => lower.includes(term))) return 'HIGH'
  if (MEDIUM_RISK_TERMS.some((term) => lower.includes(term))) return 'MEDIUM'
  return 'LOW'
}

function getRecommendedAction(riskLevel, hazardText) {
  if (riskLevel === 'HIGH') {
    return `Follow official evacuation and emergency instructions immediately for ${hazardText}.`
  }

  if (riskLevel === 'MEDIUM') {
    return `Monitor official updates closely and prepare local response teams for ${hazardText}.`
  }

  return `Continue monitoring official NDMI updates. No major emergency action is indicated right now.`
}

function parseListingPage(html) {
  const $ = cheerio.load(html)
  const reports = []

  $('table tr').each((_, row) => {
    const cells = $(row)
      .find('th, td')
      .map((__, cell) => normalizeText($(cell).text()))
      .get()

    if (cells.length < 3 || cells[0] === 'S.No.') return

    const link = $(row).find('a[href*="viewUploadedDocument"]').attr('href')

    reports.push({
      serial: cells[0],
      subject: cells[1],
      date: cells[2],
      url: toAbsoluteUrl(link),
    })
  })

  if (reports.length > 0) return reports

  $('a[href*="viewUploadedDocument"]').each((index, link) => {
    const href = $(link).attr('href')
    const subject = normalizeText($(link).text()) || `NDMI official report ${index + 1}`

    reports.push({
      serial: String(index + 1),
      subject,
      date: '',
      url: toAbsoluteUrl(href),
    })
  })

  return reports
}

async function extractDocumentText(documentUrl) {
  const response = await fetchWithTimeout(documentUrl)
  const html = await response.text()
  const $ = cheerio.load(html)

  const pdfLink = $('a[href$=".pdf"], iframe[src$=".pdf"], embed[src$=".pdf"]')
    .map((_, element) => $(element).attr('href') || $(element).attr('src'))
    .get()
    .map(toAbsoluteUrl)[0]

  if (pdfLink) {
    const pdfResponse = await fetchWithTimeout(pdfLink, {}, 12000)
    const arrayBuffer = await pdfResponse.arrayBuffer()
    const parsed = await pdfParse(Buffer.from(arrayBuffer))
    return normalizeText(parsed.text)
  }

  const bodyText = normalizeText($('body').text())
  return bodyText
}

function extractCandidateAlerts(text, reportMeta) {
  const alerts = []
  const seen = new Set()
  const lines = text
    .split(/(?<=\.)\s+|\n+/)
    .map((line) => normalizeText(line))
    .filter(Boolean)

  const pushAlert = ({ district, state, hazardType, riskLevel, sourceText }) => {
    const cleanDistrict = normalizeText(district) || 'Regional Alert'
    const cleanState = normalizeText(state) || 'India'
    const cleanHazard = normalizeText(hazardType) || 'General Disaster Alert'
    const key = `${cleanDistrict}|${cleanState}|${cleanHazard}|${riskLevel}`

    if (seen.has(key)) return
    seen.add(key)

    alerts.push({
      district: cleanDistrict,
      state: cleanState,
      hazardType: cleanHazard,
      riskLevel,
      updateTime: reportMeta.date || 'Official NDMI update',
      recommendedAction: getRecommendedAction(riskLevel, cleanHazard.toLowerCase()),
      sourceText: normalizeText(sourceText).slice(0, 280),
    })
  }

  const affectedDistrictRegex =
    /([A-Z][A-Za-z&\s]+?)\s+\d[\d\s-]*\d*\s+\d+\s*\(([^)]+)\)/g

  for (const match of text.matchAll(affectedDistrictRegex)) {
    const state = normalizeText(match[1]).replace(/\s+/g, ' ')
    const districts = splitDistrictList(match[2])
    const sourceText = normalizeText(match[0])
    const riskLevel = classifyRisk(`${reportMeta.subject} ${sourceText}`)

    districts.forEach((district) => {
      pushAlert({
        district,
        state,
        hazardType: reportMeta.subject || 'Flood / Heavy Rainfall',
        riskLevel,
        sourceText,
      })
    })
  }

  const warningSectionRegex =
    /(Red Warning|Orange Warning)[\s\S]{0,1200}?((?:[A-Z][A-Za-z]+\s+){2,12})/gi

  for (const match of text.matchAll(warningSectionRegex)) {
    const warning = normalizeText(match[1])
    const section = normalizeText(match[0])
    const riskLevel = warning.toLowerCase().includes('red') ? 'HIGH' : 'MEDIUM'
    const locationChunks = section.match(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}/g) || []
    const district = locationChunks[locationChunks.length - 1] || 'Regional Alert'
    const state = locationChunks[0] || 'India'

    pushAlert({
      district,
      state,
      hazardType: `${warning} flood warning`,
      riskLevel,
      sourceText: section,
    })
  }

  const stateAlertRegex =
    /(flood situation|extremely heavy rainfall|heavy rainfall|landslide|evacuation|casualties|cyclone)[^.]*(?:in|over)\s+([A-Z][A-Za-z&\s]+?)(?:\.|,|:)/gi

  for (const match of text.matchAll(stateAlertRegex)) {
    const hazardType = titleCaseHazard(normalizeText(match[1]))
    const state = normalizeText(match[2])
    const riskLevel = classifyRisk(`${hazardType} ${match[0]}`)

    pushAlert({
      district: 'Regional Alert',
      state,
      hazardType,
      riskLevel,
      sourceText: match[0],
    })
  }

  if (alerts.length === 0) {
    const fallbackRisk = classifyRisk(reportMeta.subject)
    alerts.push({
      district: 'Regional Alert',
      state: 'India',
      hazardType: reportMeta.subject || 'NDMI Situation Report',
      riskLevel: fallbackRisk,
      updateTime: reportMeta.date || 'Official NDMI update',
      recommendedAction: getRecommendedAction(fallbackRisk, 'official NDMI report'),
      sourceText: normalizeText(text).slice(0, 280),
    })
  }

  return alerts
    .sort((a, b) => {
      const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 }
      return riskOrder[a.riskLevel] - riskOrder[b.riskLevel]
    })
    .slice(0, 24)
}

class NdmiService {
  constructor() {
    this.cache = {
      status: 'idle',
      lastCheckedAt: null,
      nextRefreshAt: null,
      refreshIntervalMinutes: REFRESH_INTERVAL_MS / 60000,
      latestReport: null,
      alerts: [],
      error: null,
      sourceUrl: NDMI_REPORT_URL,
    }
    this.refreshPromise = null
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = (async () => {
      try {
        const listingResponse = await fetchWithTimeout(NDMI_REPORT_URL)
        const listingHtml = await listingResponse.text()
        const reports = parseListingPage(listingHtml)
        const latestReport = reports[0] ?? {
          serial: '1',
          subject: 'NDMI Situation Report',
          date: '',
          url: NDMI_REPORT_URL,
        }

        const documentText = await extractDocumentText(latestReport.url)
        const alerts = extractCandidateAlerts(documentText, latestReport)
        const now = new Date()

        this.cache = {
          status: 'ready',
          lastCheckedAt: now.toISOString(),
          nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString(),
          refreshIntervalMinutes: REFRESH_INTERVAL_MS / 60000,
          latestReport: {
            ...latestReport,
            sourceUrl: latestReport.url || NDMI_REPORT_URL,
          },
          alerts,
          error: null,
          sourceUrl: NDMI_REPORT_URL,
        }
      } catch (error) {
        const now = new Date()
        this.cache = {
          ...this.cache,
          status: 'error',
          lastCheckedAt: now.toISOString(),
          nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS).toISOString(),
          error: error.message,
        }
      } finally {
        this.refreshPromise = null
      }

      return this.cache
    })()

    return this.refreshPromise
  }

  getSnapshot() {
    return this.cache
  }

  startAutoRefresh() {
    this.refresh().catch(() => {})
    setInterval(() => {
      this.refresh().catch(() => {})
    }, REFRESH_INTERVAL_MS)
  }
}

module.exports = {
  NdmiService,
  NDMI_REPORT_URL,
}
