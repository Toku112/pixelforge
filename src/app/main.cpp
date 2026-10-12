// Application entry point: creates the Qt application, the engine services and the main window. The window's
// contents (menus, panels, viewer) arrive with PLAN Part C item 13.

#include "app/Brand.h"
#include "engine/Engine.h"
#include "engine/Scheduler.h"

#include <QApplication>
#include <QCommandLineOption>
#include <QCommandLineParser>
#include <QCoreApplication>
#include <QMainWindow>
#include <QString>
#include <QTimer>

namespace {

QString toQString(std::string_view text) {
    return QString::fromUtf8(text.data(), static_cast<qsizetype>(text.size()));
}

} // namespace

int main(int argc, char* argv[]) {
    const QApplication app(argc, argv);
    QApplication::setApplicationName(toQString(pf::APP_NAME));
    QApplication::setApplicationVersion(QStringLiteral(PF_VERSION_STRING));

    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addVersionOption();
    // For the integration tests (tests/integration): start normally, then quit once the event loop runs.
    QCommandLineOption smokeTestOption(QStringLiteral("smoke-test"),
                                       QStringLiteral("Start, show the main window and quit (startup check)."));
    smokeTestOption.setFlags(QCommandLineOption::HiddenFromHelp);
    parser.addOption(smokeTestOption);
    parser.process(app);

    // Background work never waits on this thread (CLAUDE.md §3.5); declaring it lets the engine enforce that.
    pf::engine::setUiThread();
    // Job scheduler, memory budget (60 % of RAM until Preferences > Performance sets it) and tile memory. Destroyed
    // before the application object: running jobs are cancelled and finish first.
    const pf::engine::Engine engine;

    QMainWindow window;
    window.setWindowTitle(toQString(pf::APP_NAME));
    window.resize(1280, 800);
    window.show();
    if (parser.isSet(smokeTestOption)) {
        QTimer::singleShot(0, [] { QCoreApplication::quit(); });
    }
    return QApplication::exec();
}
