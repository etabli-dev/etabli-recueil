		let allowReadOnly = (postData.hasOwnProperty("switchToReadableLibrary")) ? !postData.switchToReadableLibrary : true;
		var { library, collection, editable } = Zotero.Server.Connector.getSaveTarget(allowReadOnly);
		var response = {
			libraryID: library.libraryID,
			libraryName: library.name,
			libraryEditable: library.editable,
			filesEditable: library.filesEditable,
			editable
		};
		
		if(collection && collection.id) {
			response.id = collection.id;
			response.name = collection.name;
		} else {
			response.id = null;
			response.name = response.libraryName;
		}
		
		// Get list of editable libraries, collections, and tags
		var collections = [];
		let tags = {};
		var originalLibraryID = library.libraryID;
		for (let library of Zotero.Libraries.getAll()) {
			if (!library.editable) continue;
			
			tags[library.treeViewID] = await Zotero.Tags.getAll(library.libraryID);
			// Add recent: true for recent targets
			
			collections.push(
				{
					id: library.treeViewID,
					name: library.name,
					filesEditable: library.filesEditable,
					level: 0
				},
				...Zotero.Collections.getByLibrary(library.libraryID, true).map(c => ({
					id: c.treeViewID,
					name: c.name,
					filesEditable: library.filesEditable,
					level: c.level + 1 || 1 // Added by Zotero.Collections._getByContainer()
				}))
			);
		}
		response.targets = collections;
		response.tags = tags;
