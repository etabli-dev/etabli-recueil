import Capacitor
import UIKit
import VisionKit

/// The app's own bridge view controller: registers the plugins that live in the app target.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RecueilScannerPlugin())
    }
}

/// VisionKit's document camera for the capture screen (ADR-0024): edge detection, several pages,
/// returned as one PDF. ML Kit's document scanner is Android-only, so iOS has this instead.
@objc(RecueilScannerPlugin)
public class RecueilScannerPlugin: CAPPlugin, CAPBridgedPlugin, VNDocumentCameraViewControllerDelegate {
    public let identifier = "RecueilScannerPlugin"
    public let jsName = "RecueilScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?

    @objc func scan(_ call: CAPPluginCall) {
        guard VNDocumentCameraViewController.isSupported else {
            call.unavailable("This device has no document camera.")
            return
        }
        DispatchQueue.main.async {
            self.pendingCall = call
            let camera = VNDocumentCameraViewController()
            camera.delegate = self
            self.bridge?.viewController?.present(camera, animated: true)
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
        let data = NSMutableData()
        UIGraphicsBeginPDFContextToData(data, .zero, nil)
        for index in 0..<scan.pageCount {
            let image = scan.imageOfPage(at: index)
            let bounds = CGRect(origin: .zero, size: image.size)
            UIGraphicsBeginPDFPageWithInfo(bounds, nil)
            image.draw(in: bounds)
        }
        UIGraphicsEndPDFContext()
        let pages = scan.pageCount
        controller.dismiss(animated: true) {
            self.pendingCall?.resolve(["pdf": (data as Data).base64EncodedString(), "pageCount": pages])
            self.pendingCall = nil
        }
    }

    public func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
        controller.dismiss(animated: true) {
            self.pendingCall?.reject("Scan cancelled.")
            self.pendingCall = nil
        }
    }

    public func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
        controller.dismiss(animated: true) {
            self.pendingCall?.reject(error.localizedDescription)
            self.pendingCall = nil
        }
    }
}
