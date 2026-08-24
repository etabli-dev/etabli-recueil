	async function updateFromClient(prefix, retryOnReadOnly = true) {
		try {
			var response = await Zotero.Connector.callMethod("getSelectedCollection", { switchToReadableLibrary: true })
		}
		catch (e) {
			// TODO: Shouldn't this be coupled to the actual save process?
			changeHeadline(Zotero.getString('progressWindow_savingToOnlineLibrary'));
			return;
		}
		
		// If we're reshowing the current session's popup, override the selected location with the
		// last successful tarGet, since the selected collection in the client might have changed
		if (lastSuccessfulTarget) {
			response.id = lastSuccessfulTarget.id;
			response.name = lastSuccessfulTarget.name;
			response.libraryEditable = true;
		}
		
		// The library will change to editable upon save to a read-only library,
		// so the currently selected library information is wrong/irrelevant
		if (response.libraryEditable === false) {
			if (retryOnReadOnly) {
				setTimeout(() => updateFromClient(prefix, false), 250);
			}
			return;
		}
		
		var id;
		// Legacy response for libraries
		if (!response.id) {
			id = "L" + response.libraryID;
		}
		// Legacy response for collections
		else if (typeof response.id != 'string') {
			id = "C" + response.id;
		}
		else {
			id = response.id;
		}
		
		if (!prefix) {
			prefix = Zotero.getString('progressWindow_savingTo');
		}
		var target = {
			id,
			name: response.name,
			filesEditable: response.filesEditable
		};
		
		if (response.libraryEditable) {
			lastSuccessfulTarget = target;
		}
		
		let targets = response.targets.filter(t => !isFilesEditable || t.filesEditable);

		// TEMP: Make sure libraries have levels (added to client in 5.0.46)
		if (response.targets) {
			for (let row of response.targets) {
				if (!row.level) {
					row.level = 0;
				}
			}
		}
		
		// Format tags for autocomplete
		// Tags array contains objects {tag : ""} that may contain duplicate values due to different types
		// Unwrap the tag objects and deduplicate tags values to keep this object format {libraryID: [tag1, tag2, ...]}
		let tags = {};
		Object.entries(response.tags || []).forEach(([libraryID, tagArr]) => {
			tags[libraryID] = [...new Set(tagArr.map(item => item.tag))];
		});

		changeHeadline(prefix, target, targets, tags);
	}
