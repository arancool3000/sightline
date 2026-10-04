import SwiftUI

struct Note: Codable, Identifiable {
    var id: UUID
    var text: String
    var date: Date
}

/// Notes you write by voice: pinch Dictate (or say "take a note"), talk, and
/// say "done". "New line", "new paragraph" and "scratch that" work while dictating.
@MainActor
final class NotesApp: SpatialApp {
    let title = "Notes"
    let size = CGSize(width: 700, height: 430)
    var dirty = true
    weak var spatial: Spatial?
    private var notes: [Note] = []
    private var selected: UUID?
    private var dictatingInto: UUID?
    private var undo: [String] = []
    private var lastHeard = ""
    private var page = 0
    private let key = "vision.notes"

    init(spatial: Spatial) {
        self.spatial = spatial
        if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([Note].self, from: data) {
            notes = saved
        }
        if notes.isEmpty {
            notes = [Note(id: UUID(), text: "Welcome to Notes\nPinch Dictate, or say “take a note”, and talk. Say “done” when you’ve finished.", date: Date())]
        }
        selected = notes.first?.id
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(notes) { UserDefaults.standard.set(data, forKey: key) }
    }

    func tick(_ now: Date) {
        // Show the words as you say them.
        guard dictatingInto != nil, let heard = spatial?.voice.heard, heard != lastHeard else { return }
        lastHeard = heard
        dirty = true
    }

    func didClose() {
        if dictatingInto != nil { spatial?.voice.endDictation() }
    }

    func newNote() {
        let note = Note(id: UUID(), text: "", date: Date())
        notes.insert(note, at: 0)
        selected = note.id
        page = 0
        persist()
        startDictation()
    }

    func startDictation() {
        guard let id = selected else { return }
        dictatingInto = id
        undo = []
        dirty = true
        spatial?.voice.beginDictation(onText: { [weak self] text in
            self?.append(text, to: id)
        }, onEnd: { [weak self] in
            guard let self else { return }
            self.dictatingInto = nil
            self.notes.removeAll { $0.text.isEmpty && $0.id != self.selected }
            self.persist()
            self.dirty = true
        })
    }

    private func append(_ spoken: String, to id: UUID) {
        guard let i = notes.firstIndex(where: { $0.id == id }) else { return }
        let words = VoiceControl.normalize(spoken)
        if ["scratch that", "delete that", "undo", "undo that"].contains(words) {
            if let previous = undo.popLast() { notes[i].text = previous }
        } else {
            undo.append(notes[i].text)
            let old = notes[i].text
            let joiner = old.isEmpty || old.hasSuffix("\n") || spoken.hasPrefix("\n") ? "" : " "
            notes[i].text = old + joiner + spoken
        }
        notes[i].date = Date()
        persist()
        dirty = true
    }

    private func delete() {
        guard let id = selected else { return }
        if dictatingInto == id { spatial?.voice.endDictation() }
        notes.removeAll { $0.id == id }
        if notes.isEmpty { notes = [Note(id: UUID(), text: "", date: Date())] }
        selected = notes.first?.id
        persist()
        dirty = true
    }

    private func move(_ d: Int) {
        guard let id = selected, let i = notes.firstIndex(where: { $0.id == id }) else { return }
        let j = max(0, min(notes.count - 1, i + d))
        selected = notes[j].id
        page = j / 6
        dirty = true
    }

    func handleVoice(_ t: String) -> Bool {
        switch t {
        case "new note", "new", "take a note", "make a note": newNote()
        case "dictate", "start dictation", "start dictating", "add to note", "add to this note", "write": startDictation()
        case "delete note", "delete this note", "delete": delete()
        case "next note", "next", "down": move(1)
        case "previous note", "previous", "up", "last note": move(-1)
        default: return false
        }
        return true
    }

    func nodes() -> [UINode] {
        var list: [UINode] = [
            Look.label("title", "Notes", CGRect(x: 26, y: 20, width: 140, height: 40), size: 28, weight: .bold),
            Look.symbolButton("new", "square.and.pencil", CGRect(x: 186, y: 20, width: 42, height: 42)) { [weak self] in self?.newNote() },
        ]
        let perPage = 6
        let start = min(page * perPage, max(0, notes.count - 1))
        for (slot, note) in notes.dropFirst(start).prefix(perPage).enumerated() {
            let lines = note.text.split(separator: "\n", omittingEmptySubsequences: true)
            let title = lines.first.map(String.init) ?? ""
            let id = note.id
            let on = id == selected
            list.append(UINode("note\(slot)", CGRect(x: 16, y: 74 + CGFloat(slot) * 52, width: 216, height: 48), radius: 14, action: { [weak self] in
                self?.selected = id
            }) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title.isEmpty ? "New Note" : title).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                    Text(note.date, style: .date).font(.system(size: 11)).foregroundStyle(.white.opacity(0.6))
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(on ? 0.16 : 0)))
            })
        }
        if notes.count > perPage {
            let pages = (notes.count + perPage - 1) / perPage
            list.append(Look.symbolButton("lup", "chevron.up", CGRect(x: 66, y: 392 - 10, width: 40, height: 36)) { [weak self] in
                guard let self else { return }
                self.page = max(0, self.page - 1)
            })
            list.append(Look.symbolButton("ldown", "chevron.down", CGRect(x: 126, y: 392 - 10, width: 40, height: 36)) { [weak self] in
                guard let self else { return }
                self.page = min(pages - 1, self.page + 1)
            })
        }

        guard let note = notes.first(where: { $0.id == selected }) else { return list }
        let live = dictatingInto == note.id
        let partial = live ? (spatial?.voice.heard ?? "") : ""
        list.append(UINode("body", CGRect(x: 254, y: 24, width: 420, height: 304)) {
            (Text(note.text.isEmpty && partial.isEmpty ? (live ? "Listening…" : "Empty note") : note.text)
                .foregroundColor(note.text.isEmpty ? .white.opacity(0.4) : .white)
             + Text(partial.isEmpty ? "" : (note.text.isEmpty ? "" : " ") + partial).foregroundColor(.white.opacity(0.5)))
                .font(.system(size: 17))
                .lineLimit(13)
                .truncationMode(.head)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        })
        let id = note.id
        if live {
            list.append(Look.label("hint", "Say “new line”, “scratch that” or “done”", CGRect(x: 254, y: 334, width: 420, height: 20), size: 13, color: .white.opacity(0.6)))
            list.append(Look.pill("done", "Done", CGRect(x: 254, y: 362, width: 160, height: 46), fill: .white, textColor: .black) { [weak self] in
                self?.spatial?.voice.endDictation()
            })
        } else {
            list.append(Look.pill("dictate", "🎙  Dictate", CGRect(x: 254, y: 362, width: 160, height: 46), fill: .white, textColor: .black) { [weak self] in
                self?.selected = id
                self?.startDictation()
            })
            list.append(Look.pill("delete", "Delete", CGRect(x: 428, y: 362, width: 120, height: 46)) { [weak self] in
                self?.delete()
            })
        }
        return list
    }
}
