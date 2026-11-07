import UIKit
import Capacitor

/// The app's web view controller: Capacitor's, plus ANYfile's file-access plugin.
class AnyFileViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AnyFilePlugin())
    }
}
