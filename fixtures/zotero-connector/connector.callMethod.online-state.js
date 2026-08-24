			const xhr = await Zotero.HTTP.request(httpMethod, uri, options);
			Zotero.Connector.clientVersion = xhr.getResponseHeader('X-Zotero-Version');
			if (Zotero.Connector.isOnline !== true) {
				Zotero.Connector.isOnline = true;
				Zotero.Connector.onStateChange(Zotero.Connector.clientVersion)
			}
			var val = xhr.response
			if (xhr.responseText) {
				let contentType = xhr.getResponseHeader("Content-Type") || ""
				if (contentType.includes("application/json")) {
					val = JSON.parse(xhr.responseText);
				} else {
					val = xhr.responseText;
				}
			}
			// Zotero error responses bear an identifying header. If it's missing, treat the
			// response like a connection failure so existing save flows show their "Is Zotero
			// Running?" prompt instead of reporting an error from an unrelated localhost server.
			if (xhr.status === 0 || (xhr.status >= 400
					&& !xhr.getResponseHeader('X-Zotero-Version'))) {
				if (Zotero.Connector.isOnline !== false) {
					Zotero.Connector.isOnline = false;
					Zotero.Connector.onStateChange(Zotero.Connector.clientVersion)
				}
				throw new Zotero.Connector.CommunicationError('Connector: Zotero is offline');
			}
