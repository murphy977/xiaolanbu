import AppKit
import ApplicationServices
import Foundation
import Vision

let qianniuBundleIdentifier = "com.taobao.Aliworkbench"
let qianniuAppPath = "/Applications/Aliworkbench.app"

struct HelperFrame: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct HelperNode: Codable {
  let path: String
  let parentPath: String?
  let role: String?
  let subrole: String?
  let title: String?
  let value: String?
  let elementDescription: String?
  let frame: HelperFrame?
  let enabled: Bool?
  let actionNames: [String]
}

struct HelperWindow: Codable {
  let title: String?
  let role: String?
  let subrole: String?
  let frame: HelperFrame?
  let nodeCount: Int
  let nodes: [HelperNode]
}

struct AppSummary: Codable {
  let bundleIdentifier: String
  let name: String?
  let path: String?
  let processIdentifier: pid_t?
  let isActive: Bool
}

struct StatusPayload: Codable {
  let ok: Bool
  let helperAvailable: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let app: AppSummary?
  let windowTitles: [String]
  let timestamp: String
  let error: String?
}

struct InspectPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let app: AppSummary?
  let windows: [HelperWindow]
  let timestamp: String
  let error: String?
}

struct ActionPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let action: String
  let threadTitle: String?
  let message: String?
  let inputFound: Bool
  let sendButtonFound: Bool
  let threadMatched: Bool
  let timestamp: String
  let error: String?
}

struct OpenThreadPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let threadTitle: String?
  let threadMatched: Bool
  let timestamp: String
  let error: String?
}

struct PressLabelPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let action: String
  let label: String
  let matched: Bool
  let timestamp: String
  let error: String?
}

struct InspectAttributesPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let path: String
  let label: String?
  let attributes: [String: String]
  let timestamp: String
  let error: String?
}

struct OCRLinePayload: Codable {
  let text: String
  let confidence: Double
}

struct OCRPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let windowTitle: String?
  let cropFrame: HelperFrame?
  let text: String
  let lines: [OCRLinePayload]
  let timestamp: String
  let error: String?
}

struct ProbeSamplePayload: Codable {
  let x: Double
  let y: Double
  let role: String?
  let label: String?
  let extractedText: String?
  let attributes: [String: String]
  let parameterizedAttributes: [String]
}

struct ProbeMessageAreaPayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let viewport: HelperFrame?
  let samples: [ProbeSamplePayload]
  let timestamp: String
  let error: String?
}

struct ProbeSubtreePayload: Codable {
  let ok: Bool
  let accessibilityGranted: Bool
  let qianniuInstalled: Bool
  let qianniuRunning: Bool
  let point: HelperFrame?
  let nodes: [HelperNode]
  let timestamp: String
  let error: String?
}

struct WindowCaptureRecord {
  let windowID: CGWindowID
  let title: String
  let bounds: CGRect
}

struct NodeRef {
  let element: AXUIElement
  let node: HelperNode
}

func nowIso() -> String {
  ISO8601DateFormatter().string(from: Date())
}

func output<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  let data = try! encoder.encode(value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

func readStringAttribute(_ element: AXUIElement, _ key: String) -> String? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
  guard status == .success, let raw = value else {
    return nil
  }
  if CFGetTypeID(raw) == CFStringGetTypeID() {
    return (raw as! String).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if CFGetTypeID(raw) == CFNumberGetTypeID() {
    return String(describing: raw)
  }
  return nil
}

func readBoolAttribute(_ element: AXUIElement, _ key: String) -> Bool? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
  guard status == .success, let raw = value else {
    return nil
  }
  if CFGetTypeID(raw) == CFBooleanGetTypeID() {
    return CFBooleanGetValue((raw as! CFBoolean))
  }
  if CFGetTypeID(raw) == CFNumberGetTypeID() {
    var numeric = Int32(0)
    if CFNumberGetValue((raw as! CFNumber), .sInt32Type, &numeric) {
      return numeric != 0
    }
  }
  return nil
}

func readIntegerAttribute(_ element: AXUIElement, _ key: String) -> Int? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
  guard status == .success, let raw = value, CFGetTypeID(raw) == CFNumberGetTypeID() else {
    return nil
  }
  var numeric = Int32(0)
  if CFNumberGetValue((raw as! CFNumber), .sInt32Type, &numeric) {
    return Int(numeric)
  }
  return nil
}

func readRangeAttribute(_ element: AXUIElement, _ key: String) -> CFRange? {
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
  guard status == .success, let raw = value, CFGetTypeID(raw) == AXValueGetTypeID() else {
    return nil
  }
  let axValue = raw as! AXValue
  guard AXValueGetType(axValue) == .cfRange else {
    return nil
  }
  var range = CFRange()
  if AXValueGetValue(axValue, .cfRange, &range) {
    return range
  }
  return nil
}

func readChildren(_ element: AXUIElement) -> [AXUIElement] {
  var value: CFTypeRef?
  let keys = [kAXChildrenAttribute as String, kAXRowsAttribute as String, kAXContentsAttribute as String]
  for key in keys {
    let status = AXUIElementCopyAttributeValue(element, key as CFString, &value)
    guard status == .success, let raw = value else {
      continue
    }
    if let children = raw as? [AXUIElement], !children.isEmpty {
      return children
    }
  }
  return []
}

func readActionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  let status = AXUIElementCopyActionNames(element, &names)
  guard status == .success, let array = names as? [String] else {
    return []
  }
  return array
}

func stringifyAttributeValue(_ value: CFTypeRef?) -> String? {
  guard let value else { return nil }
  let typeId = CFGetTypeID(value)
  if typeId == CFStringGetTypeID() {
    return (value as! String).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  if typeId == CFBooleanGetTypeID() {
    return CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false"
  }
  if typeId == CFNumberGetTypeID() {
    return String(describing: value)
  }
  if typeId == AXValueGetTypeID() {
    let axValue = value as! AXValue
    let valueType = AXValueGetType(axValue)
    switch valueType {
    case .cgPoint:
      var point = CGPoint.zero
      if AXValueGetValue(axValue, .cgPoint, &point) {
        return NSStringFromPoint(point)
      }
    case .cgSize:
      var size = CGSize.zero
      if AXValueGetValue(axValue, .cgSize, &size) {
        return NSStringFromSize(size)
      }
    case .cfRange:
      var range = CFRange()
      if AXValueGetValue(axValue, .cfRange, &range) {
        return "{location=\(range.location), length=\(range.length)}"
      }
    default:
      break
    }
    return String(describing: value)
  }
  if let array = value as? [Any] {
    return array.map { String(describing: $0) }.joined(separator: ", ")
  }
  return String(describing: value)
}

func readAttributeDictionary(_ element: AXUIElement) -> [String: String] {
  var names: CFArray?
  let status = AXUIElementCopyAttributeNames(element, &names)
  guard status == .success, let rawNames = names as? [String] else {
    return [:]
  }
  var values: [String: String] = [:]
  for name in rawNames {
    var rawValue: CFTypeRef?
    let attrStatus = AXUIElementCopyAttributeValue(element, name as CFString, &rawValue)
    guard attrStatus == .success else { continue }
    if let stringified = stringifyAttributeValue(rawValue), !stringified.isEmpty {
      values[name] = stringified
    }
  }
  return values
}

func readParameterizedAttributeNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  let status = AXUIElementCopyParameterizedAttributeNames(element, &names)
  guard status == .success, let rawNames = names as? [String] else {
    return []
  }
  return rawNames
}

func readParameterizedString(_ element: AXUIElement, attribute: String, range: CFRange) -> String? {
  var mutableRange = range
  guard let rangeValue = AXValueCreate(.cfRange, &mutableRange) else {
    return nil
  }
  var value: CFTypeRef?
  let status = AXUIElementCopyParameterizedAttributeValue(element, attribute as CFString, rangeValue, &value)
  guard status == .success else {
    return nil
  }
  if let stringValue = value as? String {
    let trimmed = stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
  if let attributed = value as? NSAttributedString {
    let trimmed = attributed.string.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
  return stringifyAttributeValue(value)
}

func extractAccessibleText(_ element: AXUIElement) -> String? {
  let names = readParameterizedAttributeNames(element)
  let visibleRange = readRangeAttribute(element, kAXVisibleCharacterRangeAttribute as String)
  let numberOfCharacters = readIntegerAttribute(element, kAXNumberOfCharactersAttribute as String) ?? 0
  let candidateRanges = [
    visibleRange,
    numberOfCharacters > 0 ? CFRange(location: 0, length: numberOfCharacters) : nil,
  ].compactMap { $0 }.filter { $0.length > 0 }

  for range in candidateRanges {
    if names.contains("AXStringForRange"),
       let text = readParameterizedString(element, attribute: "AXStringForRange", range: range),
       !text.isEmpty {
      return text
    }
    if names.contains("AXAttributedStringForRange"),
       let text = readParameterizedString(element, attribute: "AXAttributedStringForRange", range: range),
       !text.isEmpty {
      return text
    }
  }
  return nil
}

func readFrame(_ element: AXUIElement) -> HelperFrame? {
  var positionValue: CFTypeRef?
  var sizeValue: CFTypeRef?
  let positionStatus = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
  let sizeStatus = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)
  guard positionStatus == .success, sizeStatus == .success else {
    return nil
  }
  guard let positionAx = positionValue, let sizeAx = sizeValue else {
    return nil
  }
  guard CFGetTypeID(positionAx) == AXValueGetTypeID(), CFGetTypeID(sizeAx) == AXValueGetTypeID() else {
    return nil
  }
  var point = CGPoint.zero
  var size = CGSize.zero
  let didReadPoint = AXValueGetValue((positionAx as! AXValue), .cgPoint, &point)
  let didReadSize = AXValueGetValue((sizeAx as! AXValue), .cgSize, &size)
  guard didReadPoint, didReadSize else {
    return nil
  }
  return HelperFrame(x: point.x, y: point.y, width: size.width, height: size.height)
}

func helperFrame(from rect: CGRect) -> HelperFrame {
  HelperFrame(x: rect.origin.x, y: rect.origin.y, width: rect.width, height: rect.height)
}

func helperNode(for element: AXUIElement, path: String, parentPath: String?) -> HelperNode {
  HelperNode(
    path: path,
    parentPath: parentPath,
    role: readStringAttribute(element, kAXRoleAttribute as String),
    subrole: readStringAttribute(element, kAXSubroleAttribute as String),
    title: readStringAttribute(element, kAXTitleAttribute as String),
    value: readStringAttribute(element, kAXValueAttribute as String),
    elementDescription: readStringAttribute(element, kAXDescriptionAttribute as String),
    frame: readFrame(element),
    enabled: readBoolAttribute(element, kAXEnabledAttribute as String),
    actionNames: readActionNames(element)
  )
}

func collectNodes(
  from element: AXUIElement,
  path: String,
  parentPath: String?,
  depth: Int,
  maxDepth: Int,
  maxNodes: Int,
  into list: inout [NodeRef]
) {
  if list.count >= maxNodes || depth > maxDepth {
    return
  }
  let node = helperNode(for: element, path: path, parentPath: parentPath)
  list.append(NodeRef(element: element, node: node))
  if list.count >= maxNodes {
    return
  }
  let children = readChildren(element)
  for (index, child) in children.enumerated() {
    if list.count >= maxNodes {
      break
    }
    collectNodes(
      from: child,
      path: "\(path).\(index)",
      parentPath: path,
      depth: depth + 1,
      maxDepth: maxDepth,
      maxNodes: maxNodes,
      into: &list
    )
  }
}

func runningQianNiuApp() -> NSRunningApplication? {
  NSRunningApplication.runningApplications(withBundleIdentifier: qianniuBundleIdentifier).first
}

func currentAppSummary() -> AppSummary? {
  guard let app = runningQianNiuApp() else {
    return nil
  }
  return AppSummary(
    bundleIdentifier: app.bundleIdentifier ?? qianniuBundleIdentifier,
    name: app.localizedName,
    path: app.bundleURL?.path,
    processIdentifier: app.processIdentifier,
    isActive: app.isActive
  )
}

func trusted(prompt: Bool) -> Bool {
  if prompt {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
  }
  return AXIsProcessTrusted()
}

func windowElements(for app: NSRunningApplication) -> [AXUIElement] {
  let applicationElement = AXUIElementCreateApplication(app.processIdentifier)
  var rawValue: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(applicationElement, kAXWindowsAttribute as CFString, &rawValue)
  guard status == .success, let windows = rawValue as? [AXUIElement] else {
    return []
  }
  return windows
}

func inspectWindows(maxDepth: Int = 8, maxNodes: Int = 1600) -> [HelperWindow] {
  guard let app = runningQianNiuApp() else {
    return []
  }
  return windowElements(for: app).map { window in
    var refs: [NodeRef] = []
    collectNodes(
      from: window,
      path: "0",
      parentPath: nil,
      depth: 0,
      maxDepth: maxDepth,
      maxNodes: maxNodes,
      into: &refs
    )
    let root = refs.first?.node ?? helperNode(for: window, path: "0", parentPath: nil)
    return HelperWindow(
      title: root.title,
      role: root.role,
      subrole: root.subrole,
      frame: root.frame,
      nodeCount: refs.count,
      nodes: refs.map(\.node)
    )
  }
}

func setupStatusPayload(error: String? = nil) -> StatusPayload {
  let installed = FileManager.default.fileExists(atPath: qianniuAppPath)
  let granted = trusted(prompt: false)
  let app = currentAppSummary()
  let windows = inspectWindows(maxDepth: 1, maxNodes: 20)
  return StatusPayload(
    ok: error == nil,
    helperAvailable: true,
    accessibilityGranted: granted,
    qianniuInstalled: installed,
    qianniuRunning: app != nil,
    app: app,
    windowTitles: windows.compactMap(\.title).filter { !$0.isEmpty },
    timestamp: nowIso(),
    error: error
  )
}

func inspectPayload(error: String? = nil) -> InspectPayload {
  let installed = FileManager.default.fileExists(atPath: qianniuAppPath)
  let granted = trusted(prompt: false)
  let app = currentAppSummary()
  let windows = granted ? inspectWindows() : []
  return InspectPayload(
    ok: error == nil,
    accessibilityGranted: granted,
    qianniuInstalled: installed,
    qianniuRunning: app != nil,
    app: app,
    windows: windows,
    timestamp: nowIso(),
    error: error
  )
}

func conversationWindow() -> HelperWindow? {
  inspectWindows().first { window in
    let title = window.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return title.contains("接待中心")
  }
}

func captureWindowRecord(titleContains keyword: String) -> WindowCaptureRecord? {
  guard let app = runningQianNiuApp() else { return nil }
  let ownerPid = Int(app.processIdentifier)
  guard let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
    return nil
  }
  let candidates = entries.compactMap { entry -> WindowCaptureRecord? in
    guard let pid = entry[kCGWindowOwnerPID as String] as? Int, pid == ownerPid else {
      return nil
    }
    let layer = entry[kCGWindowLayer as String] as? Int ?? 0
    guard layer == 0 else {
      return nil
    }
    let title = (entry[kCGWindowName as String] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty, title.contains(keyword) else {
      return nil
    }
    guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
    else {
      return nil
    }
    let number = entry[kCGWindowNumber as String] as? NSNumber
    return WindowCaptureRecord(
      windowID: CGWindowID(number?.uint32Value ?? 0),
      title: title,
      bounds: bounds
    )
  }
  let sortedCandidates = candidates.sorted { left, right in
    let leftArea = left.bounds.width * left.bounds.height
    let rightArea = right.bounds.width * right.bounds.height
    return leftArea > rightArea
  }
  return sortedCandidates.first
}

func captureWindowScreenshot(windowID: CGWindowID) -> CGImage? {
  let tempUrl = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("qianniu-window-\(windowID).png")
  try? FileManager.default.removeItem(at: tempUrl)

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-o", "-l", String(windowID), tempUrl.path]
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    return nil
  }
  guard process.terminationStatus == 0 else {
    return nil
  }
  guard let image = NSImage(contentsOf: tempUrl) else {
    try? FileManager.default.removeItem(at: tempUrl)
    return nil
  }
  var rect = NSRect(origin: .zero, size: image.size)
  let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
  try? FileManager.default.removeItem(at: tempUrl)
  return cgImage
}

func captureFullScreenScreenshot() -> CGImage? {
  let tempUrl = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("qianniu-screen-full.png")
  try? FileManager.default.removeItem(at: tempUrl)

  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", tempUrl.path]
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    return nil
  }
  guard process.terminationStatus == 0 else {
    return nil
  }
  guard let image = NSImage(contentsOf: tempUrl) else {
    try? FileManager.default.removeItem(at: tempUrl)
    return nil
  }
  var rect = NSRect(origin: .zero, size: image.size)
  let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
  try? FileManager.default.removeItem(at: tempUrl)
  return cgImage
}

func screenBoundsUnion() -> CGRect {
  let screens = NSScreen.screens
  guard let first = screens.first else {
    return CGRect(x: 0, y: 0, width: 1, height: 1)
  }
  return screens.dropFirst().reduce(first.frame) { partialResult, screen in
    partialResult.union(screen.frame)
  }
}

func messageViewportFrame(in window: HelperWindow) -> HelperFrame? {
  let splitGroup = window.nodes.first { node in
    node.path == "0.45" && node.role == "AXSplitGroup" && node.frame != nil
  } ?? window.nodes.first { node in
    node.role == "AXSplitGroup" &&
    (node.frame?.width ?? 0) > 400 &&
    (node.frame?.height ?? 0) > 300
  }
  guard let frame = splitGroup?.frame else {
    return nil
  }
  let toolbarTop = window.nodes
    .filter { node in
      node.parentPath == splitGroup?.path &&
      (node.frame?.y ?? 0) > frame.y + 180 &&
      (node.frame?.height ?? 0) <= 40
    }
    .compactMap { $0.frame?.y }
    .min()
  let bottomY = (toolbarTop ?? (frame.y + min(frame.height * 0.62, 420))) - 8
  let croppedHeight = max(80, bottomY - frame.y - 8)
  return HelperFrame(
    x: frame.x + 8,
    y: frame.y + 8,
    width: max(120, frame.width - 16),
    height: croppedHeight
  )
}

func normalizedRegionOfInterest(frame: HelperFrame, within windowBounds: CGRect) -> CGRect {
  guard windowBounds.width > 0, windowBounds.height > 0 else {
    return CGRect(x: 0, y: 0, width: 1, height: 1)
  }
  let rawRelX = (frame.x - windowBounds.origin.x) / windowBounds.width
  let rawRelYTop = (frame.y - windowBounds.origin.y) / windowBounds.height
  let rawRelWidth = frame.width / windowBounds.width
  let rawRelHeight = frame.height / windowBounds.height
  let relX = max(0, min(0.99, rawRelX))
  let relYTop = max(0, min(0.99, rawRelYTop))
  let relWidth = max(0.01, min(1 - relX, rawRelWidth))
  let relHeight = max(0.01, min(1 - relYTop, rawRelHeight))
  let relY = max(0, min(1 - relHeight, 1 - relYTop - relHeight))
  return CGRect(x: relX, y: relY, width: relWidth, height: relHeight)
}

func elementAtPosition(_ point: CGPoint) -> AXUIElement? {
  let systemWide = AXUIElementCreateSystemWide()
  var element: AXUIElement?
  let status = AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element)
  guard status == .success else {
    return nil
  }
  return element
}

func probeMessageArea() -> ProbeMessageAreaPayload {
  guard trusted(prompt: false) else {
    return ProbeMessageAreaPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      viewport: nil,
      samples: [],
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard let window = conversationWindow(),
        let viewport = messageViewportFrame(in: window)
  else {
    return ProbeMessageAreaPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      viewport: nil,
      samples: [],
      timestamp: nowIso(),
      error: "Unable to resolve 接待中心 message viewport."
    )
  }

  let columns = [0.2, 0.5, 0.8]
  let rows = [0.12, 0.28, 0.46, 0.64, 0.82]
  var samples: [ProbeSamplePayload] = []
  for row in rows {
    for column in columns {
      let point = CGPoint(
        x: viewport.x + viewport.width * column,
        y: viewport.y + viewport.height * row
      )
      guard let element = elementAtPosition(point) else {
        continue
      }
      let node = helperNode(for: element, path: "probe", parentPath: nil)
      samples.append(
        ProbeSamplePayload(
          x: point.x,
          y: point.y,
          role: node.role,
          label: nodeLabel(node),
          extractedText: extractAccessibleText(element),
          attributes: readAttributeDictionary(element),
          parameterizedAttributes: readParameterizedAttributeNames(element)
        )
      )
    }
  }
  return ProbeMessageAreaPayload(
    ok: true,
    accessibilityGranted: true,
    qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
    qianniuRunning: runningQianNiuApp() != nil,
    viewport: viewport,
    samples: samples,
    timestamp: nowIso(),
    error: nil
  )
}

func probeMessageAreaSubtree() -> ProbeSubtreePayload {
  guard trusted(prompt: false) else {
    return ProbeSubtreePayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      point: nil,
      nodes: [],
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard let window = conversationWindow(),
        let viewport = messageViewportFrame(in: window)
  else {
    return ProbeSubtreePayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      point: nil,
      nodes: [],
      timestamp: nowIso(),
      error: "Unable to resolve 接待中心 message viewport."
    )
  }
  let center = CGPoint(x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2)
  guard let element = elementAtPosition(center) else {
    return ProbeSubtreePayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      point: helperFrame(from: CGRect(x: center.x, y: center.y, width: 1, height: 1)),
      nodes: [],
      timestamp: nowIso(),
      error: "Unable to locate AX element at message area center."
    )
  }
  var refs: [NodeRef] = []
  collectNodes(
    from: element,
    path: "0",
    parentPath: nil,
    depth: 0,
    maxDepth: 8,
    maxNodes: 400,
    into: &refs
  )
  return ProbeSubtreePayload(
    ok: true,
    accessibilityGranted: true,
    qianniuInstalled: true,
    qianniuRunning: true,
    point: helperFrame(from: CGRect(x: center.x, y: center.y, width: 1, height: 1)),
    nodes: refs.map(\.node),
    timestamp: nowIso(),
    error: nil
  )
}

func ocrCurrentThread() -> OCRPayload {
  guard trusted(prompt: false) else {
    return OCRPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      windowTitle: nil,
      cropFrame: nil,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard runningQianNiuApp() != nil else {
    return OCRPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: false,
      windowTitle: nil,
      cropFrame: nil,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: "QianNiu is not running."
    )
  }
  guard let window = conversationWindow(),
        let cropFrame = messageViewportFrame(in: window)
  else {
    return OCRPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      windowTitle: nil,
      cropFrame: nil,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: "Unable to resolve 接待中心 window or message viewport."
    )
  }
  let fullScreenBounds = screenBoundsUnion()
  let region = normalizedRegionOfInterest(frame: cropFrame, within: fullScreenBounds)
  guard region.width > 0, region.height > 0,
        region.minX >= 0, region.minY >= 0,
        region.maxX <= 1, region.maxY <= 1
  else {
    return OCRPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      windowTitle: window.title,
      cropFrame: cropFrame,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: "Calculated OCR region is out of screen bounds."
    )
  }
  guard let image = captureFullScreenScreenshot() else {
    return OCRPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      windowTitle: window.title,
      cropFrame: cropFrame,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: "Failed to capture full screen image."
    )
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  request.regionOfInterest = region

  do {
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []
    let lines = observations
      .compactMap { observation -> (OCRLinePayload, CGRect)? in
        guard let candidate = observation.topCandidates(1).first else {
          return nil
        }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
          return nil
        }
        return (
          OCRLinePayload(text: text, confidence: Double(candidate.confidence)),
          observation.boundingBox
        )
      }
      .sorted { left, right in
        let leftY = left.1.midY
        let rightY = right.1.midY
        if abs(leftY - rightY) > 0.02 {
          return leftY > rightY
        }
        return left.1.minX < right.1.minX
      }
      .map(\.0)
    return OCRPayload(
      ok: true,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      windowTitle: window.title,
      cropFrame: cropFrame,
      text: lines.map(\.text).joined(separator: "\n"),
      lines: lines,
      timestamp: nowIso(),
      error: nil
    )
  } catch {
    return OCRPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      windowTitle: window.title,
      cropFrame: cropFrame,
      text: "",
      lines: [],
      timestamp: nowIso(),
      error: error.localizedDescription
    )
  }
}

func flattenNodeRefs() -> [NodeRef] {
  guard let app = runningQianNiuApp() else {
    return []
  }
  var all: [NodeRef] = []
  for window in windowElements(for: app) {
    collectNodes(
      from: window,
      path: "0",
      parentPath: nil,
      depth: 0,
      maxDepth: 8,
      maxNodes: 2400,
      into: &all
    )
  }
  return all
}

func collectWindowRefs(
  from window: AXUIElement,
  maxDepth: Int = 8,
  maxNodes: Int = 1200
) -> [NodeRef] {
  var refs: [NodeRef] = []
  collectNodes(
    from: window,
    path: "0",
    parentPath: nil,
    depth: 0,
    maxDepth: maxDepth,
    maxNodes: maxNodes,
    into: &refs
  )
  return refs
}

func isReminderWindowTitle(_ title: String?) -> Bool {
  let normalized = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  guard !normalized.isEmpty else { return false }
  return normalized.contains("消息提醒") || normalized.contains("提醒")
}

func isLikelyReminderWindow(_ window: AXUIElement) -> Bool {
  let title = readStringAttribute(window, kAXTitleAttribute as String)
  if isReminderWindowTitle(title) {
    return true
  }
  let normalized = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if normalized.contains("接待中心") || normalized.contains("工作台") {
    return false
  }
  guard let frame = readFrame(window) else {
    return false
  }
  return frame.width <= 520 && frame.height <= 320 && frame.x >= 900
}

func threadTargetRef(threadTitle: String, preferReminderPopup: Bool = true) -> NodeRef? {
  let trimmed = threadTitle.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, let app = runningQianNiuApp() else {
    return nil
  }

  let windows = windowElements(for: app)
  if preferReminderPopup {
    for window in windows where isLikelyReminderWindow(window) {
      let refs = collectWindowRefs(from: window, maxDepth: 8, maxNodes: 600)
      if let match = findElementPathMatch(refs, query: trimmed),
         let target = ancestorActionableRef(for: match, in: refs) {
        return target
      }
    }
  }

  if let conversation = windows.first(where: {
    let title = readStringAttribute($0, kAXTitleAttribute as String) ?? ""
    return title.contains("接待中心")
  }) {
    let refs = collectWindowRefs(from: conversation, maxDepth: 8, maxNodes: 1600)
    if let match = findElementPathMatch(refs, query: trimmed),
       let target = ancestorActionableRef(for: match, in: refs) {
      return target
    }
  }

  for window in windows {
    let refs = collectWindowRefs(from: window, maxDepth: 8, maxNodes: 1000)
    if let match = findElementPathMatch(refs, query: trimmed),
       let target = ancestorActionableRef(for: match, in: refs) {
      return target
    }
  }

  return nil
}

func nodeLabel(_ node: HelperNode) -> String {
  let candidates = [node.title, node.value, node.elementDescription]
  for item in candidates {
    let trimmed = item?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !trimmed.isEmpty {
      return trimmed
    }
  }
  return ""
}

func frameMidX(_ frame: HelperFrame?) -> Double {
  guard let frame else { return 0 }
  return frame.x + frame.width / 2
}

func frameMidY(_ frame: HelperFrame?) -> Double {
  guard let frame else { return 0 }
  return frame.y + frame.height / 2
}

func clickFrameCenter(_ frame: HelperFrame?) -> Bool {
  guard let frame else { return false }
  let point = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
  guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
  else {
    return false
  }
  move.post(tap: .cghidEventTap)
  usleep(40_000)
  down.post(tap: .cghidEventTap)
  usleep(20_000)
  up.post(tap: .cghidEventTap)
  usleep(180_000)
  return true
}

func pressElement(_ element: AXUIElement, frame: HelperFrame? = nil) -> Bool {
  let actions = readActionNames(element)
  if actions.contains(kAXPressAction as String) {
    if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success {
      return true
    }
  }
  if actions.contains(kAXShowMenuAction as String) {
    if AXUIElementPerformAction(element, kAXShowMenuAction as CFString) == .success {
      return true
    }
  }
  return clickFrameCenter(frame)
}

func isActionable(role: String?) -> Bool {
  guard let role else { return false }
  return ["AXButton", "AXMenuButton", "AXRow", "AXCell", "AXLink", "AXGroup", "AXMenuItem", "AXCheckBox", "AXRadioButton"].contains(role)
}

func findElementPathMatch(_ refs: [NodeRef], query: String) -> NodeRef? {
  let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  let ranked = refs.compactMap { ref -> (NodeRef, Int)? in
    let label = nodeLabel(ref.node)
    guard !label.isEmpty else { return nil }
    let score: Int
    if label == trimmed {
      score = 100
    } else if label.contains(trimmed) || trimmed.contains(label) {
      score = 70
    } else {
      return nil
    }
    return (ref, score)
  }
  .sorted { left, right in
    if left.1 != right.1 {
      return left.1 > right.1
    }
    return frameMidX(left.0.node.frame) < frameMidX(right.0.node.frame)
  }
  return ranked.first?.0
}

func ancestorActionableRef(for ref: NodeRef, in refs: [NodeRef]) -> NodeRef? {
  if isActionable(role: ref.node.role) {
    return ref
  }
  var currentParent = ref.node.parentPath
  while let parentPath = currentParent {
    if let parent = refs.first(where: { $0.node.path == parentPath }) {
      if isActionable(role: parent.node.role) {
        return parent
      }
      currentParent = parent.node.parentPath
    } else {
      break
    }
  }
  return nil
}

func setFocused(_ element: AXUIElement) {
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
}

func findComposerRef(in refs: [NodeRef]) -> NodeRef? {
  let candidates = refs.filter { ref in
    guard let role = ref.node.role else { return false }
    guard role == "AXTextArea" || role == "AXTextField" else { return false }
    guard let frame = ref.node.frame else { return false }
    return frame.width > 120 && frame.height > 20
  }
  return candidates.sorted { left, right in
    if frameMidY(left.node.frame) != frameMidY(right.node.frame) {
      return frameMidY(left.node.frame) > frameMidY(right.node.frame)
    }
    return (left.node.frame?.width ?? 0) > (right.node.frame?.width ?? 0)
  }.first
}

func findSendButtonRef(in refs: [NodeRef]) -> NodeRef? {
  let candidates = refs.filter { ref in
    guard ref.node.role == "AXButton" || ref.node.role == "AXMenuButton" else { return false }
    let label = nodeLabel(ref.node)
    if label.contains("发送") || label.lowercased().contains("send") {
      return true
    }
    return false
  }
  return candidates.sorted { left, right in
    frameMidY(left.node.frame) > frameMidY(right.node.frame)
  }.first
}

func sendReply(threadTitle: String?, message: String) -> ActionPayload {
  guard trusted(prompt: false) else {
    return ActionPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      action: "send-reply",
      threadTitle: threadTitle,
      message: message,
      inputFound: false,
      sendButtonFound: false,
      threadMatched: false,
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard let app = runningQianNiuApp() else {
    return ActionPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: false,
      action: "send-reply",
      threadTitle: threadTitle,
      message: message,
      inputFound: false,
      sendButtonFound: false,
      threadMatched: false,
      timestamp: nowIso(),
      error: "QianNiu is not running."
    )
  }

  _ = app.activate(options: [.activateIgnoringOtherApps])
  usleep(300_000)

  var matched = false
  if let threadTitle, !threadTitle.isEmpty,
     let target = threadTargetRef(threadTitle: threadTitle, preferReminderPopup: true) {
    matched = pressElement(target.element, frame: target.node.frame)
    usleep(300_000)
  }

  let refreshedRefs = flattenNodeRefs()
  guard let composer = findComposerRef(in: refreshedRefs) else {
    return ActionPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      action: "send-reply",
      threadTitle: threadTitle,
      message: message,
      inputFound: false,
      sendButtonFound: false,
      threadMatched: matched,
      timestamp: nowIso(),
      error: "Unable to locate message composer."
    )
  }

  setFocused(composer.element)
  let setValueStatus = AXUIElementSetAttributeValue(composer.element, kAXValueAttribute as CFString, message as CFTypeRef)
  guard setValueStatus == .success else {
    return ActionPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      action: "send-reply",
      threadTitle: threadTitle,
      message: message,
      inputFound: true,
      sendButtonFound: false,
      threadMatched: matched,
      timestamp: nowIso(),
      error: "Unable to set message composer value."
    )
  }

  guard let sendButton = findSendButtonRef(in: refreshedRefs) else {
    return ActionPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      action: "send-reply",
      threadTitle: threadTitle,
      message: message,
      inputFound: true,
      sendButtonFound: false,
      threadMatched: matched,
      timestamp: nowIso(),
      error: "Unable to locate send button."
    )
  }

  let didPress = pressElement(sendButton.element, frame: sendButton.node.frame)
  return ActionPayload(
    ok: didPress,
    accessibilityGranted: true,
    qianniuInstalled: true,
    qianniuRunning: true,
    action: "send-reply",
    threadTitle: threadTitle,
    message: message,
    inputFound: true,
    sendButtonFound: true,
    threadMatched: matched,
    timestamp: nowIso(),
    error: didPress ? nil : "Failed to press send button."
  )
}

func openThread(threadTitle: String) -> OpenThreadPayload {
  guard trusted(prompt: false) else {
    return OpenThreadPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      threadTitle: threadTitle,
      threadMatched: false,
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard let app = runningQianNiuApp() else {
    return OpenThreadPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: false,
      threadTitle: threadTitle,
      threadMatched: false,
      timestamp: nowIso(),
      error: "QianNiu is not running."
    )
  }

  _ = app.activate(options: [.activateIgnoringOtherApps])
  usleep(300_000)

  guard let target = threadTargetRef(threadTitle: threadTitle, preferReminderPopup: true) else {
    return OpenThreadPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      threadTitle: threadTitle,
      threadMatched: false,
      timestamp: nowIso(),
      error: "Unable to locate target thread."
    )
  }
  let didPress = pressElement(target.element, frame: target.node.frame)
  if didPress {
    usleep(300_000)
  }
  return OpenThreadPayload(
    ok: didPress,
    accessibilityGranted: true,
    qianniuInstalled: true,
    qianniuRunning: true,
    threadTitle: threadTitle,
    threadMatched: didPress,
    timestamp: nowIso(),
    error: didPress ? nil : "Failed to activate target thread."
  )
}

func pressLabel(_ label: String) -> PressLabelPayload {
  guard trusted(prompt: false) else {
    return PressLabelPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      action: "press-label",
      label: label,
      matched: false,
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard let app = runningQianNiuApp() else {
    return PressLabelPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: false,
      action: "press-label",
      label: label,
      matched: false,
      timestamp: nowIso(),
      error: "QianNiu is not running."
    )
  }

  _ = app.activate(options: [.activateIgnoringOtherApps])
  usleep(300_000)

  let refs = flattenNodeRefs()
  guard let match = findElementPathMatch(refs, query: label) else {
    return PressLabelPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      action: "press-label",
      label: label,
      matched: false,
      timestamp: nowIso(),
      error: "Unable to locate target label."
    )
  }
  let target = ancestorActionableRef(for: match, in: refs) ?? match
  let didPress = pressElement(target.element, frame: target.node.frame)
  if didPress {
    usleep(300_000)
  }
  return PressLabelPayload(
    ok: didPress,
    accessibilityGranted: true,
    qianniuInstalled: true,
    qianniuRunning: true,
    action: "press-label",
    label: label,
    matched: true,
    timestamp: nowIso(),
    error: didPress ? nil : "Failed to press target element."
  )
}

func inspectAttributes(path: String) -> InspectAttributesPayload {
  guard trusted(prompt: false) else {
    return InspectAttributesPayload(
      ok: false,
      accessibilityGranted: false,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: runningQianNiuApp() != nil,
      path: path,
      label: nil,
      attributes: [:],
      timestamp: nowIso(),
      error: "Accessibility permission is not granted."
    )
  }
  guard runningQianNiuApp() != nil else {
    return InspectAttributesPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
      qianniuRunning: false,
      path: path,
      label: nil,
      attributes: [:],
      timestamp: nowIso(),
      error: "QianNiu is not running."
    )
  }
  let refs = flattenNodeRefs()
  guard let ref = refs.first(where: { $0.node.path == path }) else {
    return InspectAttributesPayload(
      ok: false,
      accessibilityGranted: true,
      qianniuInstalled: true,
      qianniuRunning: true,
      path: path,
      label: nil,
      attributes: [:],
      timestamp: nowIso(),
      error: "Unable to locate target node path."
    )
  }
  return InspectAttributesPayload(
    ok: true,
    accessibilityGranted: true,
    qianniuInstalled: true,
    qianniuRunning: true,
    path: path,
    label: nodeLabel(ref.node),
    attributes: readAttributeDictionary(ref.element),
    timestamp: nowIso(),
    error: nil
  )
}

func requestAccessibility() -> StatusPayload {
  _ = trusted(prompt: true)
  if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
    NSWorkspace.shared.open(url)
  }
  return setupStatusPayload()
}

let command = CommandLine.arguments.dropFirst().first ?? "status"
switch command {
case "status":
  output(setupStatusPayload())
case "request-accessibility":
  output(requestAccessibility())
case "inspect-ui":
  output(inspectPayload())
case "open-thread":
  let args = Array(CommandLine.arguments.dropFirst())
  var threadTitle = ""
  var index = 1
  while index < args.count {
    let arg = args[index]
    if arg == "--thread-title", index + 1 < args.count {
      threadTitle = args[index + 1]
      index += 2
      continue
    }
    index += 1
  }
  output(openThread(threadTitle: threadTitle))
case "send-reply":
  let args = Array(CommandLine.arguments.dropFirst())
  var threadTitle: String?
  var message = ""
  var index = 1
  while index < args.count {
    let arg = args[index]
    if arg == "--thread-title", index + 1 < args.count {
      threadTitle = args[index + 1]
      index += 2
      continue
    }
    if arg == "--message", index + 1 < args.count {
      message = args[index + 1]
      index += 2
      continue
    }
    index += 1
  }
  output(sendReply(threadTitle: threadTitle, message: message))
case "press-label":
  let args = Array(CommandLine.arguments.dropFirst())
  var label = ""
  var index = 1
  while index < args.count {
    let arg = args[index]
    if arg == "--label", index + 1 < args.count {
      label = args[index + 1]
      index += 2
      continue
    }
    index += 1
  }
  output(pressLabel(label))
case "inspect-attributes":
  let args = Array(CommandLine.arguments.dropFirst())
  var path = ""
  var index = 1
  while index < args.count {
    let arg = args[index]
    if arg == "--path", index + 1 < args.count {
      path = args[index + 1]
      index += 2
      continue
    }
    index += 1
  }
  output(inspectAttributes(path: path))
case "ocr-current-thread":
  output(ocrCurrentThread())
case "probe-message-area":
  output(probeMessageArea())
case "probe-message-area-subtree":
  output(probeMessageAreaSubtree())
default:
  output(StatusPayload(
    ok: false,
    helperAvailable: true,
    accessibilityGranted: trusted(prompt: false),
    qianniuInstalled: FileManager.default.fileExists(atPath: qianniuAppPath),
    qianniuRunning: runningQianNiuApp() != nil,
    app: currentAppSummary(),
    windowTitles: [],
    timestamp: nowIso(),
    error: "Unsupported command: \(command)"
  ))
}
