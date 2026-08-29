# PricePulse Backend Server
# Real product scraping + AI image search
# Run: powershell -ExecutionPolicy Bypass -File server.ps1

$Port = 8080
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

$PlatformMap = @{
    amazon  = @{ name = "Amazon";  color = "amazon";  domains = @("amazon.in", "amazon.com") }
    flipkart = @{ name = "Flipkart"; color = "flipkart"; domains = @("flipkart.com") }
    myntra  = @{ name = "Myntra";  color = "myntra";  domains = @("myntra.com") }
    ajio    = @{ name = "Ajio";    color = "ajio";    domains = @("ajio.com") }
    nykaa   = @{ name = "Nykaa";   color = "nykaa";   domains = @("nykaa.com") }
    croma   = @{ name = "Croma";   color = "croma";   domains = @("croma.com") }
}

function Send-Response {
    param($Context, $Body, [int]$Status = 200, [string]$ContentType = "application/json")
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Context.Response.StatusCode = $Status
    $Context.Response.ContentType = $ContentType
    $Context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
    $Context.Response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    $Context.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Send-Json {
    param($Context, $Obj, [int]$Status = 200)
    $json = $Obj | ConvertTo-Json -Depth 10 -Compress
    Send-Response -Context $Context -Body $json -Status $Status
}

function Send-Error {
    param($Context, [string]$Message, [int]$Status = 400)
    Send-Json -Context $Context -Obj @{ error = $Message } -Status $Status
}

function Fetch-Page {
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -Headers @{
            "User-Agent" = $UserAgent
            "Accept-Language" = "en-IN,en;q=0.9"
            "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        } -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5
        return $resp.Content
    } catch {
        return $null
    }
}

function Decode-Html {
    param([string]$Text)
    if (-not $Text) { return "" }
    $t = $Text -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'" -replace '&nbsp;', ' '
    return $t.Trim()
}

function Extract-Meta {
    param([string]$Html, [string]$Property)
    if ($Html -match "property=`"$Property`"\s+content=`"([^`"]+)`"") { return Decode-Html $Matches[1] }
    if ($Html -match "content=`"([^`"]+)`"\s+property=`"$Property`"") { return Decode-Html $Matches[1] }
    if ($Html -match "name=`"$Property`"\s+content=`"([^`"]+)`"") { return Decode-Html $Matches[1] }
    return $null
}

function Extract-JsonLd {
    param([string]$Html)
    $results = @()
    $pattern = '<script[^>]*type="application/ld\+json"[^>]*>([\s\S]*?)</script>'
    $matches = [regex]::Matches($Html, $pattern, 'IgnoreCase')
    foreach ($m in $matches) {
        try {
            $json = $m.Groups[1].Value.Trim() | ConvertFrom-Json
            $results += $json
        } catch {}
    }
    return $results
}

function Parse-Price {
    param([string]$Text)
    if (-not $Text) { return $null }
    $clean = $Text -replace '[^\d.,]', ''
    $clean = $clean -replace ',', ''
    if ($clean -match '([\d]+\.?\d*)') {
        $val = [decimal]$Matches[1]
        if ($val -gt 0 -and $val -lt 10000000) { return [int]$val }
    }
    return $null
}

function Detect-Platform {
    param([string]$Url)
    $lower = $Url.ToLower()
    foreach ($key in $PlatformMap.Keys) {
        foreach ($domain in $PlatformMap[$key].domains) {
            if ($lower -match [regex]::Escape($domain)) { return $key }
        }
    }
    return "unknown"
}

function Extract-ProductFromHtml {
    param([string]$Html, [string]$Url)

    $title = Extract-Meta $Html "og:title"
    $image = Extract-Meta $Html "og:image"
    $price = $null
    $mrp = $null

    # JSON-LD Product schema
    $ldItems = Extract-JsonLd $Html
    foreach ($ld in $ldItems) {
        $items = @($ld)
        if ($ld.'@graph') { $items = @($ld.'@graph') }
        foreach ($item in $items) {
            $type = $item.'@type'
            if ($type -eq 'Product' -or ($type -is [array] -and 'Product' -in $type)) {
                if (-not $title -and $item.name) { $title = $item.name }
                if (-not $image -and $item.image) {
                    $img = $item.image
                    if ($img -is [array]) { $image = $img[0] }
                    elseif ($img -is [string]) { $image = $img }
                    elseif ($img.url) { $image = $img.url }
                }
                if ($item.offers) {
                    $offer = $item.offers
                    if ($offer -is [array]) { $offer = $offer[0] }
                    if ($offer.price) { $price = Parse-Price $offer.price.ToString() }
                    if ($offer.highPrice) { $mrp = Parse-Price $offer.highPrice.ToString() }
                }
            }
        }
    }

    # Amazon-specific
    if ($Url -match 'amazon') {
        if ($Html -match 'id="productTitle"[^>]*>\s*([\s\S]*?)\s*</span>') {
            $amazonTitle = ($Matches[1] -replace '<[^>]+>', '').Trim()
            if ($amazonTitle) { $title = $amazonTitle }
        }
        if (-not $price -and $Html -match '"priceAmount"\s*:\s*([\d.]+)') {
            $price = Parse-Price $Matches[1]
        }
        if (-not $price -and $Html -match 'class="a-price-whole"[^>]*>([\d,]+)') {
            $price = Parse-Price $Matches[1]
        }
        if (-not $image -and $Html -match '"hiRes"\s*:\s*"([^"]+)"') {
            $image = $Matches[1]
        }
    }

    # Flipkart-specific
    if ($Url -match 'flipkart') {
        if ($Html -match 'class="B_NuCI"[^>]*>([^<]+)') {
            $title = Decode-Html $Matches[1]
        }
        if (-not $price -and $Html -match 'class="_30jeq3[^"]*"[^>]*>([^<]+)') {
            $price = Parse-Price $Matches[1]
        }
        if (-not $mrp -and $Html -match 'class="_3I9_wc[^"]*"[^>]*>([^<]+)') {
            $mrp = Parse-Price $Matches[1]
        }
    }

    # Myntra-specific
    if ($Url -match 'myntra') {
        if ($Html -match 'class="pdp-name"[^>]*>([^<]+)') {
            $title = Decode-Html $Matches[1]
        }
        if (-not $price -and $Html -match 'class="pdp-price"[^>]*>\s*<strong[^>]*>([^<]+)') {
            $price = Parse-Price $Matches[1]
        }
        if (-not $price -and $Html -match '"price"\s*:\s*"?(?:Rs\.?\s*)?([\d,]+)"?') {
            $price = Parse-Price $Matches[1]
        }
    }

    # Ajio-specific
    if ($Url -match 'ajio') {
        if ($Html -match 'class="prod-name"[^>]*>([^<]+)') {
            $title = Decode-Html $Matches[1]
        }
        if (-not $price -and $Html -match 'class="prod-sp"[^>]*>([^<]+)') {
            $price = Parse-Price $Matches[1]
        }
    }

    # Generic price fallbacks
    if (-not $price -and $Html -match 'property="product:price:amount"\s+content="([^"]+)"') {
        $price = Parse-Price $Matches[1]
    }
    if (-not $price -and $Html -match '"price"\s*:\s*"?([\d,]+\.?\d*)"?') {
        $price = Parse-Price $Matches[1]
    }

    # Clean title
    if ($title) {
        $title = $title -replace '\s*[:\|]\s*Buy.*$', '' -replace '\s*[:\|]\s*Online.*$', ''
        $title = $title -replace '\s*-\s*(Amazon|Flipkart|Myntra|Ajio|Nykaa).*$', ''
        $title = $title.Trim()
    }

    return @{
        title = $title
        image = $image
        price = $price
        mrp = $mrp
    }
}

function Get-SearchQuery {
    param([string]$Title)
    if (-not $Title) { return "" }
    $q = $Title -replace '\([^)]*\)', '' -replace '\s+', ' '
    $words = ($q.Trim() -split '\s+')
    if ($words.Count -gt 8) { $q = ($words[0..7] -join ' ') }
    return $q.Trim()
}

function Search-GoogleShopping {
    param([string]$Query)
    $results = @()
    $searchUrl = "https://www.google.com/search?q=" + [uri]::EscapeDataString($Query) + "&tbm=shop&hl=en&gl=in"
    $html = Fetch-Page $searchUrl
    if (-not $html) { return $results }

    # Parse shopping result blocks
    $blocks = [regex]::Matches($html, '<div[^>]*class="[^"]*sh-dgr__content[^"]*"[^>]*>([\s\S]*?)</div>\s*</div>\s*</div>', 'IgnoreCase')
    if ($blocks.Count -eq 0) {
        $blocks = [regex]::Matches($html, 'data-docid="([^"]+)"([\s\S]{0,2000}?)(?:Rs\.?\s*)([\d,]+)', 'IgnoreCase')
        foreach ($b in $blocks) {
            $priceVal = Parse-Price $b.Groups[3].Value
            $blockHtml = $b.Groups[2].Value
            $linkMatch = [regex]::Match($blockHtml, 'href="(/url\?[^"]+|https?://[^"]+)"')
            $titleMatch = [regex]::Match($blockHtml, 'aria-label="([^"]+)"')
            if ($titleMatch.Success -and $priceVal) {
                $link = $titleMatch.Groups[1].Value
                if ($link -match 'q=([^&]+)') { $link = [uri]::UnescapeDataString($Matches[1]) }
                $source = Detect-Platform $link
                $results += @{
                    title = Decode-Html $titleMatch.Groups[1].Value
                    price = $priceVal
                    url = $link
                    platformId = if ($source -ne "unknown") { $source } else { "other" }
                    platform = if ($source -ne "unknown") { $PlatformMap[$source].name } else { "Store" }
                    color = if ($source -ne "unknown") { $PlatformMap[$source].color } else { "amazon" }
                    image = $null
                }
            }
        }
        return $results
    }

    foreach ($block in $blocks) {
        $content = $block.Groups[1].Value
        $titleMatch = [regex]::Match($content, 'aria-label="([^"]+)"')
        if (-not $titleMatch.Success) {
            $titleMatch = [regex]::Match($content, 'class="[^"]*tAxDx[^"]*"[^>]*>([^<]+)')
        }
        $priceMatch = [regex]::Match($content, '(?:Rs\.?\s*)([\d,]+(?:\.\d+)?)')
        $linkMatch = [regex]::Match($content, 'href="(/url\?[^"]+)""')
        if (-not $linkMatch.Success) {
            $linkMatch = [regex]::Match($content, 'href="(https?://[^"]+)"')
        }

        if ($titleMatch.Success -and $priceMatch.Success) {
            $link = $linkMatch.Groups[1].Value
            if ($link -match 'url\?q=([^&]+)') {
                $link = [uri]::UnescapeDataString($Matches[1])
            } elseif ($link -match '/url\?.*q=([^&]+)') {
                $link = [uri]::UnescapeDataString($Matches[1])
            }
            $source = Detect-Platform $link
            $imgMatch = [regex]::Match($content, 'src="(https?://[^"]+)"')
            $results += @{
                title = Decode-Html $titleMatch.Groups[1].Value
                price = Parse-Price $priceMatch.Groups[1].Value
                url = $link
                platformId = if ($source -ne "unknown") { $source } else { "other" }
                platform = if ($source -ne "unknown") { $PlatformMap[$source].name } else { "Store" }
                color = if ($source -ne "unknown") { $PlatformMap[$source].color } else { "amazon" }
                image = if ($imgMatch.Success) { $imgMatch.Groups[1].Value } else { $null }
            }
        }
    }
    return $results
}

function Search-PlatformDirect {
    param([string]$PlatformId, [string]$Query)
    $encoded = [uri]::EscapeDataString($Query)
    $searchUrls = @{
        amazon   = "https://www.amazon.in/s?k=$encoded"
        flipkart = "https://www.flipkart.com/search?q=$encoded"
        myntra   = "https://www.myntra.com/$($encoded -replace '%20','-')"
        ajio     = "https://www.ajio.com/search/?text=$encoded"
        nykaa    = "https://www.nykaa.com/search/result/?q=$encoded"
        croma    = "https://www.croma.com/search/?q=$encoded"
    }

    if (-not $searchUrls.ContainsKey($PlatformId)) { return $null }
    $html = Fetch-Page $searchUrls[$PlatformId]
    if (-not $html) { return $null }

    $result = $null

    switch ($PlatformId) {
        "amazon" {
            if ($html -match 'data-component-type="s-search-result"[\s\S]{0,3000}?href="(/[^"]+/dp/[^"?]+)') {
                $link = "https://www.amazon.in" + ($Matches[1] -replace '&amp;','&')
                $block = $Matches[0]
                $t = if ($block -match 'alt="([^"]+)"') { $Matches[1] } else { $Query }
                $p = if ($block -match '(?:₹|Rs\.?\s*)([\d,]+)') { Parse-Price $Matches[1] } else { $null }
                $img = if ($block -match 'src="(https://m\.media-amazon\.com[^"]+)"') { $Matches[1] } else { $null }
                $result = @{ title = $t; price = $p; url = $link; image = $img }
            }
        }
        "flipkart" {
            if ($html -match 'href="(/[^"]+/p/[^"?]+)"') {
                $link = "https://www.flipkart.com" + $Matches[1]
                $block = $Matches[0]
                $t = if ($html -match 'title="([^"]+)"') { $Matches[1] } else { $Query }
                $p = if ($html -match 'class="_30jeq3[^"]*"[^>]*>([^<]+)') { Parse-Price $Matches[1] } else { $null }
                $result = @{ title = $t; price = $p; url = $link; image = $null }
            }
        }
        "myntra" {
            if ($html -match 'href="(/[^"]+/buy)"') {
                $link = "https://www.myntra.com" + $Matches[1]
                $t = if ($html -match 'class="product-product"[^>]*>([^<]+)') { $Matches[1] } else { $Query }
                $p = if ($html -match 'class="product-discountedPrice"[^>]*>\s*<span[^>]*>([^<]+)') { Parse-Price $Matches[1] } else { $null }
                $result = @{ title = $t; price = $p; url = $link; image = $null }
            }
        }
        "ajio" {
            if ($html -match 'href="(/[^"]+/p/[^"?]+)"') {
                $link = "https://www.ajio.com" + $Matches[1]
                $t = if ($html -match 'class="nameCls"[^>]*>([^<]+)') { $Matches[1] } else { $Query }
                $p = if ($html -match 'class="price"[^>]*>([^<]+)') { Parse-Price $Matches[1] } else { $null }
                $result = @{ title = $t; price = $p; url = $link; image = $null }
            }
        }
    }
    return $result
}

function Compare-ProductPrices {
    param([string]$Url)

    $html = Fetch-Page $Url
    if (-not $html) {
        throw "Could not fetch the product page. Check the URL and try again."
    }

    $product = Extract-ProductFromHtml $html $Url
    if (-not $product.title) {
        throw "Could not extract product details from this link. Try a direct product page URL."
    }

    $sourcePlatform = Detect-Platform $Url
    $searchQuery = Get-SearchQuery $product.title
    $allResults = @()

    # Source product entry
    $sourceEntry = @{
        platform = if ($sourcePlatform -ne "unknown") { $PlatformMap[$sourcePlatform].name } else { "Source" }
        platformId = $sourcePlatform
        color = if ($sourcePlatform -ne "unknown") { $PlatformMap[$sourcePlatform].color } else { "amazon" }
        price = $product.price
        mrp = $product.mrp
        discount = if ($product.mrp -and $product.price -and $product.mrp -gt $product.price) {
            [int][math]::Round((1 - $product.price / $product.mrp) * 100)
        } else { 0 }
        url = $Url
        inStock = $true
        isSource = $true
        title = $product.title
        image = $product.image
    }
    $allResults += $sourceEntry

    # Google Shopping aggregated results
    $shoppingResults = Search-GoogleShopping $searchQuery
    $seenPlatforms = @{ $sourcePlatform = $true }

    foreach ($sr in $shoppingResults) {
        $pid = $sr.platformId
        if ($pid -eq "other" -or $pid -eq "unknown") { continue }
        if ($seenPlatforms.ContainsKey($pid)) { continue }
        if (-not $sr.price) { continue }

        $seenPlatforms[$pid] = $true
        $allResults += @{
            platform = $PlatformMap[$pid].name
            platformId = $pid
            color = $PlatformMap[$pid].color
            price = $sr.price
            mrp = $null
            discount = 0
            url = $sr.url
            inStock = $true
            isSource = $false
            title = $sr.title
            image = $sr.image
        }
    }

    # Direct platform search for missing platforms
    $targetPlatforms = @("amazon", "flipkart", "myntra", "ajio", "nykaa", "croma")
    foreach ($pid in $targetPlatforms) {
        if ($seenPlatforms.ContainsKey($pid)) { continue }
        $direct = Search-PlatformDirect $pid $searchQuery
        if ($direct -and $direct.price) {
            $seenPlatforms[$pid] = $true
            $allResults += @{
                platform = $PlatformMap[$pid].name
                platformId = $pid
                color = $PlatformMap[$pid].color
                price = $direct.price
                mrp = $null
                discount = 0
                url = $direct.url
                inStock = $true
                isSource = $false
                title = $direct.title
                image = $direct.image
            }
        }
    }

    # Sort by price (nulls last)
    $sorted = $allResults | Sort-Object { if ($_.price) { $_.price } else { [int]::MaxValue } }

    $prices = @($sorted | Where-Object { $_.price } | ForEach-Object { $_.price })
    $savings = if ($prices.Count -ge 2) { ($prices | Measure-Object -Maximum).Maximum - ($prices | Measure-Object -Minimum).Minimum } else { 0 }

    return @{
        product = @{
            name = $product.title
            image = $product.image
        }
        results = @($sorted)
        bestPrice = if ($prices.Count -gt 0) { ($prices | Measure-Object -Minimum).Minimum } else { $null }
        savings = $savings
        searchQuery = $searchQuery
    }
}

function Get-ImageCaption {
    param([byte[]]$ImageBytes)

    # Try Hugging Face BLIP (free AI vision)
    try {
        $uri = "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base"
        $response = Invoke-RestMethod -Uri $uri -Method Post -Body $ImageBytes -ContentType "application/octet-stream" -TimeoutSec 30
        if ($response.generated_text) {
            return @{ caption = $response.generated_text; confidence = 88 }
        }
    } catch {}

    # Fallback: try alternate HF model
    try {
        $uri = "https://api-inference.huggingface.co/models/nlpconnect/vit-gpt2-image-captioning"
        $response = Invoke-RestMethod -Uri $uri -Method Post -Body $ImageBytes -ContentType "application/octet-stream" -TimeoutSec 30
        if ($response -is [array] -and $response[0].generated_text) {
            return @{ caption = $response[0].generated_text; confidence = 82 }
        }
        if ($response.generated_text) {
            return @{ caption = $response.generated_text; confidence = 82 }
        }
    } catch {}

    return $null
}

function Search-ByImage {
    param([byte[]]$ImageBytes, [string]$ImageDataUrl)

    $ai = Get-ImageCaption $ImageBytes

    if (-not $ai) {
        throw "AI could not analyze this image. Try a clearer product photo."
    }

    $caption = $ai.caption
    $searchQuery = Get-SearchQuery $caption

    # Search Google Shopping for visual matches
    $shoppingResults = Search-GoogleShopping $searchQuery

    $results = @()
    $seen = @{}

    foreach ($sr in $shoppingResults) {
        $key = $sr.platform + $sr.title
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true

        $results += @{
            title = $sr.title
            source = $sr.platform
            price = $sr.price
            url = $sr.url
            image = if ($sr.image) { $sr.image } else { $null }
        }
    }

    # Also search major platforms directly
    foreach ($pid in @("amazon", "flipkart", "myntra", "ajio")) {
        if ($results.Count -ge 12) { break }
        $direct = Search-PlatformDirect $pid $searchQuery
        if ($direct -and $direct.price) {
            $key = $PlatformMap[$pid].name + $direct.title
            if (-not $seen.ContainsKey($key)) {
                $seen[$key] = $true
                $results += @{
                    title = $direct.title
                    source = $PlatformMap[$pid].name
                    price = $direct.price
                    url = $direct.url
                    image = $direct.image
                }
            }
        }
    }

    if ($results.Count -eq 0) {
        throw "No matching products found for `"$caption`". Try a clearer image."
    }

    return @{
        detectedProduct = $caption
        confidence = $ai.confidence
        results = $results
        statuses = @(
            "Analyzing image with AI…",
            "Detected: $caption",
            "Searching across the web…",
            "Found $($results.Count) matching listings"
        )
    }
}

function Serve-StaticFile {
    param($Context, [string]$FilePath)
    if (-not (Test-Path $FilePath)) {
        Send-Error -Context $Context -Message "Not found" -Status 404
        return
    }
    $ext = [System.IO.Path]::GetExtension($FilePath).ToLower()
    $mime = @{
        ".html" = "text/html; charset=utf-8"
        ".css"  = "text/css; charset=utf-8"
        ".js"   = "application/javascript; charset=utf-8"
        ".png"  = "image/png"
        ".jpg"  = "image/jpeg"
        ".jpeg" = "image/jpeg"
        ".svg"  = "image/svg+xml"
        ".ico"  = "image/x-icon"
        ".json" = "application/json"
    }
    $contentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
    $bytes = [System.IO.File]::ReadAllBytes($FilePath)
    $Context.Response.StatusCode = 200
    $Context.Response.ContentType = $contentType
    $Context.Response.ContentLength64 = $bytes.Length
    $Context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Context.Response.Close()
}

function Read-Body {
    param($Context)
    $reader = New-Object System.IO.StreamReader($Context.Request.InputStream, [System.Text.Encoding]::UTF8)
    return $reader.ReadToEnd()
}

# ===== HTTP Server =====
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

Write-Host ""
Write-Host "  PricePulse Server running" -ForegroundColor Magenta
Write-Host "  Open: http://localhost:$Port" -ForegroundColor Yellow
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $path = $request.Url.LocalPath
        $method = $request.HttpMethod

        if ($method -eq "OPTIONS") {
            Send-Response -Context $context -Body "" -Status 204
            continue
        }

        try {
            if ($path -eq "/api/compare" -and $method -eq "POST") {
                $body = Read-Body $context | ConvertFrom-Json
                if (-not $body.url) { Send-Error $context "URL is required"; continue }
                $result = Compare-ProductPrices $body.url
                Send-Json $context $result
            }
            elseif ($path -eq "/api/search-image" -and $method -eq "POST") {
                $body = Read-Body $context | ConvertFrom-Json
                if (-not $body.image) { Send-Error $context "Image is required"; continue }

                $base64 = $body.image
                if ($base64 -match '^data:image/[^;]+;base64,(.+)$') {
                    $base64 = $Matches[1]
                }
                $imageBytes = [Convert]::FromBase64String($base64)
                $result = Search-ByImage $imageBytes $body.image
                Send-Json $context $result
            }
            elseif ($path -eq "/api/health") {
                Send-Json $context @{ status = "ok"; version = "2.0" }
            }
            else {
                # Static files
                $relativePath = $path.TrimStart('/')
                if ($relativePath -eq "" -or $relativePath -eq "/") { $relativePath = "index.html" }
                $filePath = Join-Path $Root ($relativePath -replace '/', [System.IO.Path]::DirectorySeparatorChar)
                Serve-StaticFile $context $filePath
            }
        } catch {
            $msg = $_.Exception.Message
            Write-Host "  Error: $msg" -ForegroundColor Red
            Send-Error $context $msg -Status 500
        }
    }
} finally {
    $listener.Stop()
}
