# Share to Life OS: the Shortcut recipe

This puts a "Life OS" entry in the share sheet of your iPhone and iPad. Pick some
text in WhatsApp, Notes, Mail or anywhere, tap Share, tap "Life OS", and it lands
in the Inbox tab of Life OS as a task. The whole message is kept in the task's
note, and its first line becomes the title.

iOS has no built-in way for a web app to appear in the share sheet, so a Shortcut
does the job. You build it once on the iPhone and once on the iPad (or let iCloud
share it between them).

## Before you start

1. Open Life OS from its Home Screen icon.
2. Go to Settings, then "Share to Life OS".
3. Type a label such as "iPhone" and tap "Create token".
4. The token appears once, in a box. Press and hold it, tap Select All, then Copy.
   If you lose it, revoke it and create another. It cannot be shown again.

Keep the token to yourself. Anyone who has it can add items to your Inbox. They
cannot read anything, and they can do nothing else, but revoke it from the same
Settings panel if you ever think it has leaked.

## Build the Shortcut

1. Open the Shortcuts app and tap the plus sign to make a new Shortcut.
2. Tap the name at the top and call it "Life OS".
3. Tap the small "i" (Shortcut details) at the bottom. Turn on "Show in Share
   Sheet". Under "Share Sheet Types", keep only "Text" (and "URLs" if you want to
   share web pages; the link then arrives as text).
4. Back on the main screen, the first action is already "Receive Text from Share
   Sheet". Leave it as it is. If it says "If there is no input", choose "Ask For"
   and "Text", so running the Shortcut by hand still works.
5. Tap "Add Action", search for "Get Contents of URL" and add it.
6. In that action, set the URL to your Life OS address followed by `/api/capture`,
   for example `https://your-life-os-address/api/capture`.
7. Tap "Show More" in the same action and set:
   - Method: POST
   - Headers: tap "Add new header". The key is `Authorization`. The value is the
     word `Bearer`, a space, then the token you copied. Example shape:
     `Bearer lo_cap_xxxxxxxx`.
   - Request Body: JSON.
8. Under the JSON body, tap "Add new field", choose "Text". The key is `text`. For
   the value, tap the field and choose the variable "Shortcut Input" (the text that
   came from the share sheet).
9. Add one more action after it: "Get Dictionary Value". Set it to get the value
   for the key `ok` in "Contents of URL".
10. Add the last action, "Show Notification" (or "Show Result"). For the message,
    use "Saved to Life OS" when `ok` is true. The simplest form is a plain "Show
    Notification" that says "Saved to Life OS". If something goes wrong (a wrong
    token, or more than 4,000 characters), Life OS answers with an error and the
    Shortcut shows it instead.

## Use it

1. In any app, select the text and tap Share (or the share arrow).
2. Scroll the share sheet and tap "Life OS". The first time, allow the Shortcut to
   connect to your Life OS address.
3. You see "Saved to Life OS". Open Life OS, tap Tasks, then the Inbox tab: the
   item is there.

## What to expect

- Up to 4,000 characters per share, and up to 60 shares a day.
- Sharing the same text twice within ten minutes gives you the same task, not two.
- The text is treated as written by somebody else. Life OS never follows anything
  inside it, and your assistants read it as data, never as instructions.
- To stop a device from sharing, revoke its token in Settings, "Share to Life OS".
  The Shortcut then shows an error until you paste a new token into it.
